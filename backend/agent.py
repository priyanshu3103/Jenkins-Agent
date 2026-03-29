"""
Jenkins Build Failure AI Agent  +  REST API
=============================================
Continuously polls Jenkins for build failures, uses Google Gemini (free) to
analyze root causes and identify responsible developers, then posts to Slack.
Also exposes a FastAPI REST server so the React UI can fetch live data.

Usage:
    python agent.py              # poller + API server (recommended)
    python agent.py --api-only   # API server only
    python agent.py --no-api     # poller only

Endpoints (default port 8000):
    GET  /api/builds              → all failed builds (live from Jenkins)
    GET  /api/builds/{job}/{num}  → single build detail + console
    POST /api/analyze             → trigger Gemini analysis for a build
    GET  /api/jobs                → list all Jenkins jobs
    GET  /health                  → health check

Requirements:
    pip install requests python-dotenv fastapi uvicorn

Get a FREE Gemini API key at: https://aistudio.google.com/apikey
"""

import os
import sys
import time
import json
import logging
import hashlib
import threading
from datetime import datetime
from typing import Optional
import requests
from dotenv import load_dotenv

load_dotenv()

# ─── Logging ─────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("agent.log"),
    ],
)
log = logging.getLogger(__name__)


CONFIG_FILE = "runtime_config.json"

def load_runtime_config():
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE) as f:
            data = json.load(f)
            return data.get("JENKINS_API_URL")
    return None

def save_runtime_config(jenkins_url: str):
    tmp_file = CONFIG_FILE + ".tmp"
    with open(tmp_file, "w") as f:
        json.dump({"JENKINS_API_URL": jenkins_url}, f)
    os.replace(tmp_file, CONFIG_FILE)

# ─── Config ──────────────────────────────────────────────────────────────────

JENKINS_API_URL = load_runtime_config() or os.getenv(
    "JENKINS_API_URL", "https://jenkins.example.com")
JENKINS_USER      = os.getenv("JENKINS_USER", "admin")
JENKINS_TOKEN     = os.getenv("JENKINS_TOKEN", "")
SLACK_WEBHOOK_URL = os.getenv("SLACK_WEBHOOK_URL", "")
SLACK_CHANNEL     = os.getenv("SLACK_CHANNEL", "#build-alerts")
POLL_INTERVAL_SEC = int(os.getenv("POLL_INTERVAL_SEC", "300"))
JENKINS_JOBS      = os.getenv("JENKINS_JOBS", "").split(",")
SEEN_BUILDS_FILE  = os.getenv("SEEN_BUILDS_FILE", "seen_builds.json")
API_PORT          = int(os.getenv("API_PORT", "8000"))
API_HOST          = os.getenv("API_HOST", "0.0.0.0")
#CONFIG_FILE         = "runtime_config.json"

# ── Gemini config ─────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")  # free & fast
GEMINI_URL     = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

# In-memory cache: { "job#number" -> analysis_dict | "__error__" }
MAX_CACHE_SIZE = 1000
_analysis_cache: dict = {}
_cache_lock = threading.Lock()



# # Create load + save helpers
# def load_runtime_config():
#     if os.path.exists(CONFIG_FILE):
#         with open(CONFIG_FILE) as f:
#             data = json.load(f)
#             return data.get("JENKINS_API_URL")
#     return None


# def save_runtime_config(jenkins_url: str):
#     with open(CONFIG_FILE, "w") as f:
#         json.dump({"JENKINS_API_URL": jenkins_url}, f)

# ─── State persistence ────────────────────────────────────────────────────────

def load_seen_builds() -> set:
    if os.path.exists(SEEN_BUILDS_FILE):
        with open(SEEN_BUILDS_FILE) as f:
            return set(json.load(f))
    return set()


def save_seen_builds(seen: set) -> None:
    tmp = SEEN_BUILDS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(list(seen), f)
    os.replace(tmp, SEEN_BUILDS_FILE)

_config_lock = threading.Lock()
# ─── Jenkins API ─────────────────────────────────────────────────────────────

def jenkins_get(path: str) -> Optional[dict]:
    with _config_lock:
        base_url = JENKINS_API_URL

    url = f"{base_url.rstrip('/')}/{path.lstrip('/')}/api/json"

    for _ in range(2):  # retry once
        try:
            resp = requests.get(url, auth=(JENKINS_USER, JENKINS_TOKEN), timeout=10)
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException:
            time.sleep(1)

    log.warning(f"Jenkins request failed for {path}")
    return None


def get_all_jobs() -> list:
    data = jenkins_get("")
    if not data:
        return []
    return [j["name"] for j in data.get("jobs", [])]


def get_latest_build(job_name: str) -> Optional[dict]:
    return jenkins_get(f"job/{job_name}/lastBuild")


def get_build_console(job_name: str, build_number: int) -> str:
    with _config_lock:
        base_url = JENKINS_API_URL
    url = f"{base_url.rstrip('/')}/job/{job_name}/{build_number}/consoleText"
    try:
        resp = requests.get(url, auth=(JENKINS_USER, JENKINS_TOKEN), timeout=15, stream=True)
        resp.raise_for_status()
        return resp.text[:8192]
    except requests.RequestException as e:
        log.warning(f"Could not fetch console for {job_name}#{build_number}: {e}")
        return "(console unavailable)"


def get_build_changes(job_name: str, build_number: int) -> list:
    data = jenkins_get(f"job/{job_name}/{build_number}")
    if not data:
        return []
    changes = []
    for cs in data.get("changeSets", []):
        for item in cs.get("items", []):
            changes.append({
                "commitId":  item.get("commitId", "unknown")[:8],
                "author":    item.get("author", {}).get("fullName", "unknown"),
                "message":   item.get("msg", ""),
                "timestamp": item.get("timestamp", 0),
            })
    return changes


def get_build_triggered_by(build: dict) -> dict:
    """Extract who/what triggered this build from Jenkins build actions."""
    triggered_by = "unknown"
    trigger_type = "unknown"

    for action in build.get("actions", []):
        causes = action.get("causes", [])
        for cause in causes:
            cls = cause.get("_class", "")
            if "UserIdCause" in cls:
                triggered_by = cause.get("userName") or cause.get("userId", "unknown")
                trigger_type = "user"
                break
            elif "TimerTriggerCause" in cls:
                triggered_by = "Scheduled Timer"
                trigger_type = "timer"
                break
            elif "SCMTriggerCause" in cls:
                triggered_by = "SCM Push"
                trigger_type = "scm"
                break
            elif "UpstreamCause" in cls:
                upstream = cause.get("upstreamProject", "upstream job")
                triggered_by = f"Upstream: {upstream}"
                trigger_type = "upstream"
                break
            elif "shortDescription" in cause:
                triggered_by = cause["shortDescription"]
                trigger_type = "other"
                break
        if trigger_type != "unknown":
            break

    return {"triggeredBy": triggered_by, "triggerType": trigger_type}


def build_uid(job_name: str, build_number: int) -> str:
    return hashlib.md5(f"{job_name}#{build_number}".encode()).hexdigest()


# ─── Gemini AI Analysis ───────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a senior DevOps engineer analyzing Jenkins CI/CD build failures.
Given a failed build's details, you must return ONLY a valid JSON object —
no markdown fences, no preamble, no trailing text.

JSON schema:
{
  "rootCause":         "concise technical root cause",
  "responsible":       "Full Name",
  "responsibleEmail":  "email if known, else empty string",
  "responsibility":    "1-2 sentences explaining why this person is responsible",
  "fix":               "step-by-step concrete fix",
  "severity":          "Critical | High | Medium | Low",
  "estimatedFixTime":  "e.g. 30 minutes",
  "category":          "test_failure | compile_error | dependency | timeout | oom | config | other",
  "tags":              ["array", "of", "relevant", "tags"]
}"""


def call_gemini(prompt: str) -> str:
    """Call Gemini API and return raw text response."""
    if not GEMINI_API_KEY:
        raise ValueError("GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey")

    full_prompt = f"{SYSTEM_PROMPT}\n\n{prompt}"

    url = f"{GEMINI_URL}?key={GEMINI_API_KEY}"

    last_error = None

    # 🔁 Retry logic (2 attempts)
    for attempt in range(2):
        try:
            resp = requests.post(
                url,
                json={
                    "contents": [{"parts": [{"text": full_prompt}]}],
                    "generationConfig": {
                        "maxOutputTokens": 2048,
                        "temperature": 0.1,
                    },
                },
                timeout=30,
            )

            resp.raise_for_status()
            data = resp.json()

            # 🔍 API-level error
            if "error" in data:
                raise ValueError(f"Gemini API error: {data['error'].get('message', 'unknown')}")

            # 🔍 Validate structure
            candidates = data.get("candidates")
            if not candidates:
                raise ValueError("No candidates returned from Gemini")

            parts = candidates[0].get("content", {}).get("parts", [])
            if not parts:
                raise ValueError("Invalid Gemini response structure (no parts)")

            text = parts[0].get("text", "").strip()
            if not text:
                raise ValueError("Empty response from Gemini")

            # 🧹 Clean markdown fences
            text = text.replace("```json", "").replace("```", "").strip()

            return text

        except requests.Timeout:
            log.warning(f"Gemini timeout (attempt {attempt+1})")

        except requests.HTTPError as e:
            status = e.response.status_code if e.response else "?"
            log.error(f"Gemini HTTP {status} error (attempt {attempt+1}): {e}")

            # ❌ Do NOT retry for auth/quota errors
            if status in (400, 401, 403):
                raise

        except Exception as e:
            log.error(f"Gemini error (attempt {attempt+1}): {e}")
            last_error = e

        # ⏳ Backoff before retry
        time.sleep(1)

    # ❌ Final failure
    raise RuntimeError(f"Gemini failed after retries: {last_error}")


def analyze_failure(job: str, build: dict, console: str, changes: list) -> Optional[dict]:
    """Ask Gemini to analyze a build failure and return structured JSON."""
    cache_key = f"{job}#{build.get('number')}"

    # ── Check cache (thread-safe) ────────────────────────────────────────────
    with _cache_lock:
        cached = _analysis_cache.get(cache_key)
        if cached == "__error__":
            log.warning(f"Skipping analysis for {cache_key} — previous attempt failed permanently.")
            return None
        if isinstance(cached, dict):
            log.info(f"Returning cached analysis for {cache_key}")
            return cached

    # ── Prepare prompt ───────────────────────────────────────────────────────
    changes_text = "\n".join(
        f"  - [{c['commitId']}] {c['author']}: {c['message']}"
        for c in changes
    ) or "  (no change information available)"

    trigger = get_build_triggered_by(build)

    prompt = f"""Analyze this Jenkins build failure:

Job:           {job}
Build #:       {build.get('number')}
Branch/URL:    {build.get('url', 'unknown')}
Duration:      {round(build.get('duration', 0) / 1000)}s
Result:        {build.get('result')}
Triggered by:  {trigger['triggeredBy']} ({trigger['triggerType']})

Recent commits in this build:
{changes_text}

Console output (last portion):
{console[-4000:]}"""

    text = ""

    try:
        log.info(f"🤖 Calling Gemini for {cache_key}...")
        text = call_gemini(prompt)

        # ── Safe JSON parsing ────────────────────────────────────────────────
        result = json.loads(text)

        # ── Cache result with size control ───────────────────────────────────
        with _cache_lock:
            if len(_analysis_cache) > MAX_CACHE_SIZE:
                _analysis_cache.pop(next(iter(_analysis_cache)))  # remove oldest

            _analysis_cache[cache_key] = result

        log.info(f"✅ Gemini analysis complete for {cache_key} — severity: {result.get('severity')}")
        return result

    except json.JSONDecodeError:
        log.error(f"Gemini returned non-JSON for {cache_key}: {text[:300]}")
        with _cache_lock:
            _analysis_cache[cache_key] = "__error__"
        return None

    except requests.HTTPError as e:
        status = e.response.status_code if e.response else "?"
        log.error(f"Gemini HTTP {status} error for {cache_key}: {e}")

        # Permanent failures (don’t retry)
        if status in (400, 401, 403, 429):
            with _cache_lock:
                _analysis_cache[cache_key] = "__error__"

        return None

    except Exception as e:
        log.error(f"Gemini error for {cache_key}: {e}")

        with _cache_lock:
            _analysis_cache[cache_key] = "__error__"

        return None


# ─── Slack Notifications ──────────────────────────────────────────────────────

SEVERITY_EMOJI = {"Critical": "🔴", "High": "🟠", "Medium": "🟡", "Low": "🟢"}
CATEGORY_EMOJI = {
    "test_failure": "🧪", "compile_error": "🔨", "dependency": "📦",
    "timeout": "⏱️", "oom": "💾", "config": "⚙️", "other": "❓",
}
TRIGGER_EMOJI = {
    "user": "👤", "timer": "⏰", "scm": "🔀",
    "upstream": "🔗", "other": "▶", "unknown": "▶",
}


def post_to_slack(job: str, build: dict, analysis: dict) -> bool:
    if not SLACK_WEBHOOK_URL:
        log.info("No Slack webhook configured — printing to console instead.")
        print_slack_preview(job, build, analysis)
        return True

    trigger   = get_build_triggered_by(build)
    sev       = analysis.get("severity", "High")
    cat       = analysis.get("category", "other")
    emoji     = SEVERITY_EMOJI.get(sev, "🔴")
    cat_e     = CATEGORY_EMOJI.get(cat, "❓")
    trig_e    = TRIGGER_EMOJI.get(trigger["triggerType"], "▶")
    build_url = build.get("url", "#")
    ts        = datetime.fromtimestamp(build.get("timestamp", 0) / 1000).strftime("%Y-%m-%d %H:%M:%S")

    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": f"{emoji} Build Failure — {job} #{build.get('number')}", "emoji": True}},
        {
            "type": "section",
            "fields": [
                {"type": "mrkdwn", "text": f"*Severity:*\n{emoji} {sev}"},
                {"type": "mrkdwn", "text": f"*Category:*\n{cat_e} {cat.replace('_', ' ').title()}"},
                {"type": "mrkdwn", "text": f"*Triggered By:*\n{trig_e} {trigger['triggeredBy']}"},
                {"type": "mrkdwn", "text": f"*Responsible:*\n👤 {analysis.get('responsible', 'Unknown')}"},
                {"type": "mrkdwn", "text": f"*Est. Fix Time:*\n⏱ {analysis.get('estimatedFixTime', 'Unknown')}"},
                {"type": "mrkdwn", "text": f"*Failed At:*\n{ts}"},
            ],
        },
        {"type": "divider"},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*🔍 Root Cause*\n{analysis.get('rootCause', 'Unknown')}"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*👤 Why {analysis.get('responsible', 'this person')}?*\n{analysis.get('responsibility', '')}"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*✅ Recommended Fix*\n{analysis.get('fix', 'See console logs.')}"}},
    ]

    tags = analysis.get("tags", [])
    if tags:
        blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": " ".join(f"`{t}`" for t in tags)}]})

    blocks.append({"type": "actions", "elements": [
        {"type": "button", "text": {"type": "plain_text", "text": "🔗 View Build", "emoji": True}, "url": build_url, "style": "danger"}
    ]})

    payload = {
        "channel": SLACK_CHANNEL,
        "text": f"{emoji} Build failure in *{job}* — triggered by {trigger['triggeredBy']} — {sev} severity",
        "blocks": blocks,
    }
    for _ in range(2):
        try:
            resp = requests.post(SLACK_WEBHOOK_URL, json=payload, timeout=10)
            resp.raise_for_status()
            log.info(f"Slack notification sent for {job}#{build.get('number')}")
            return True
        except requests.RequestException as e:
            time.sleep(1)
    log.error("Slack post failed after retries")
    return False


def print_slack_preview(job: str, build: dict, analysis: dict) -> None:
    trigger = get_build_triggered_by(build)
    sev     = analysis.get("severity", "?")
    emoji   = SEVERITY_EMOJI.get(sev, "🔴")
    sep     = "─" * 60
    print(f"\n{sep}")
    print(f"{emoji}  BUILD FAILURE  |  {job} #{build.get('number')}  |  {sev}")
    print(sep)
    print(f"  Triggered By : {trigger['triggeredBy']} ({trigger['triggerType']})")
    print(f"  Responsible  : {analysis.get('responsible')} <{analysis.get('responsibleEmail', '')}>")
    print(f"  Root Cause   : {analysis.get('rootCause')}")
    print(f"  Category     : {analysis.get('category')}")
    print(f"  Fix Time est : {analysis.get('estimatedFixTime')}")
    print(f"\n  Why them?\n  {analysis.get('responsibility')}")
    print(f"\n  Fix:\n  {analysis.get('fix')}")
    print(f"\n  Tags: {', '.join(analysis.get('tags', []))}")
    print(f"\n  Build URL: {build.get('url', 'N/A')}")
    print(sep + "\n")


# ─── Core polling loop ────────────────────────────────────────────────────────

def poll_once(seen: set) -> set:
    jobs = JENKINS_JOBS if JENKINS_JOBS and JENKINS_JOBS != [""] else get_all_jobs()

    if not jobs:
        log.warning("No jobs found. Check your Jenkins URL and credentials.")
        return seen

    log.info(f"Checking {len(jobs)} job(s): {', '.join(jobs[:10])}{'...' if len(jobs) > 10 else ''}")

    for job in jobs:
        build = get_latest_build(job.strip())
        if not build:
            continue

        result = build.get("result")
        number = build.get("number")

        if result != "FAILURE":
            continue

        uid = build_uid(job, number)
        if uid in seen:
            continue

        trigger = get_build_triggered_by(build)
        log.info(f"🔴 New failure: {job} #{number} — triggered by {trigger['triggeredBy']}")

        console  = get_build_console(job, number)
        changes  = get_build_changes(job, number)
        analysis = analyze_failure(job, build, console, changes)

        if not analysis:
            log.warning(f"Analysis failed for {job}#{number}, skipping Slack.")
            seen.add(uid)
            continue

        post_to_slack(job, build, analysis)
        seen.add(uid)
        save_seen_builds(seen)
        time.sleep(2)

    return seen


def run():
    log.info("=" * 60)
    log.info("  Jenkins Build Failure AI Agent  started")
    with _config_lock:
        current = JENKINS_API_URL
    log.info(f"  Jenkins : {current}")
    log.info(f"  AI      : Gemini ({GEMINI_MODEL})")
    log.info(f"  Slack   : {SLACK_CHANNEL if SLACK_WEBHOOK_URL else '(console only)'}")
    log.info(f"  Interval: {POLL_INTERVAL_SEC}s")
    log.info("=" * 60)

    if not GEMINI_API_KEY:
        log.warning("⚠ GEMINI_API_KEY is not set! Get a free key at https://aistudio.google.com/apikey")

    seen = load_seen_builds()
    log.info(f"Loaded {len(seen)} previously seen build IDs.")

    while True:
        try:
            seen = poll_once(seen)
        except KeyboardInterrupt:
            log.info("Interrupted by user. Exiting.")
            break
        except Exception as e:
            log.error(f"Unexpected error in poll loop: {e}", exc_info=True)

        log.info(f"Sleeping {POLL_INTERVAL_SEC}s until next poll...")
        time.sleep(POLL_INTERVAL_SEC)


# ─── FastAPI REST Server ──────────────────────────────────────────────────────

def _build_to_dict(job_name: str, build: dict, console: str = "", changes: list = []) -> dict:
    number = build.get("number", 0)

    branch = "unknown"
    for action in build.get("actions", []):
        for branch_info in action.get("branches", []):
            branch = branch_info.get("name", branch).replace("origin/", "")
            break

    commit, commit_msg, author_name, author_email = "", "", "unknown", ""
    if changes:
        last        = changes[-1]
        commit      = last.get("commitId", "")
        commit_msg  = last.get("message", "")
        author_name = last.get("author", "unknown")

    trigger = get_build_triggered_by(build)

    cache_key = f"{job_name}#{number}"
    with _cache_lock:
        cached = _analysis_cache.get(cache_key)
    analysis = cached if isinstance(cached, dict) else None

    return {
        "id":            cache_key,
        "job":           job_name,
        "number":        number,
        "status":        build.get("result", "UNKNOWN"),
        "timestamp":     build.get("timestamp", 0),
        "duration":      build.get("duration", 0),
        "branch":        branch,
        "commit":        commit[:8] if commit else "",
        "commitMessage": commit_msg,
        "author":        author_email,
        "authorName":    author_name,
        "triggeredBy":   trigger["triggeredBy"],
        "triggerType":   trigger["triggerType"],
        "console":       console,
        "url":           build.get("url", ""),
        "analysis":      analysis,
    }


def create_app():
    try:
        from fastapi import FastAPI, HTTPException, BackgroundTasks
        from fastapi.middleware.cors import CORSMiddleware
        from pydantic import BaseModel
    except ImportError:
        log.error("FastAPI not installed. Run: pip install fastapi uvicorn")
        return None

    app = FastAPI(title="Jenkins Failure Agent API", version="1.0.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health():
        with _config_lock:
            current = JENKINS_API_URL
        return {
            "status": "ok",
            "jenkins": current,
            "ai": f"gemini/{GEMINI_MODEL}",
            "timestamp": datetime.utcnow().isoformat()
        }

    
    @app.post("/api/config")
    def set_config(data: dict):
        global JENKINS_API_URL

        jenkins_url = data.get("jenkins_url")

        # 🔹 Validation
        if not jenkins_url:
            raise HTTPException(status_code=400, detail="jenkins_url required")

        if not isinstance(jenkins_url, str):
            raise HTTPException(status_code=400, detail="Invalid Jenkins URL")

        # 🔥 Auto-add protocol
        if not jenkins_url.startswith("http"):
            jenkins_url = "http://" + jenkins_url

        # 🔥 Fix localhost issue (IMPORTANT)
        if "localhost" in jenkins_url or "127.0.0.1" in jenkins_url:
            log.info(f"🔄 Converting {jenkins_url} → internal K8s service")
        jenkins_url = "http://jenkins:8080"

        # 🔹 Normalize (remove trailing slash)
        jenkins_url = jenkins_url.rstrip("/")

        try:
            # 🔹 Optional: test connectivity (recommended)
            test_resp = requests.get(f"{jenkins_url}/api/json", timeout=10)
            test_resp.raise_for_status()
        except Exception as e:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot reach Jenkins at {jenkins_url}: {str(e)}"
            )

        # 🔹 Update runtime config
        with _config_lock:
            JENKINS_API_URL = jenkins_url
            save_runtime_config(jenkins_url)
            current = JENKINS_API_URL

        return {
            "status": "ok",
            "jenkins": current
        }

    @app.get("/api/jobs")
    def list_jobs():
        jobs = get_all_jobs()
        return {"jobs": jobs, "total": len(jobs)}

    @app.get("/api/builds")
    def list_failed_builds():
        jobs = JENKINS_JOBS if JENKINS_JOBS and JENKINS_JOBS != [""] else get_all_jobs()
        failures = []
        for job in jobs:
            job   = job.strip()
            build = get_latest_build(job)
            if build and build.get("result") == "FAILURE":
                changes = get_build_changes(job, build["number"])
                failures.append(_build_to_dict(job, build, changes=changes))
        failures.sort(key=lambda b: b["timestamp"], reverse=True)
        return {"builds": failures, "total": len(failures)}

    @app.get("/api/builds/{job_name}/{build_number}")
    def get_build_detail(job_name: str, build_number: int):
        build = jenkins_get(f"job/{job_name}/{build_number}")
        if not build:
            raise HTTPException(status_code=404, detail="Build not found")
        console = get_build_console(job_name, build_number)
        changes = get_build_changes(job_name, build_number)
        return _build_to_dict(job_name, build, console=console, changes=changes)

    class AnalyzeRequest(BaseModel):
        job: str
        build_number: int

    @app.post("/api/analyze")
    def trigger_analysis(req: AnalyzeRequest, background_tasks: BackgroundTasks):
        cache_key = f"{req.job}#{req.build_number}"
        with _cache_lock:
            cached = _analysis_cache.get(cache_key)
        if cached and isinstance(cached, dict):
            return {"status": "cached", "analysis": cached}

        build = jenkins_get(f"job/{req.job}/{req.build_number}")
        if not build:
            raise HTTPException(status_code=404, detail="Build not found")

        console  = get_build_console(req.job, req.build_number)
        changes  = get_build_changes(req.job, req.build_number)
        analysis = analyze_failure(req.job, build, console, changes)

        if not analysis:
            raise HTTPException(status_code=500, detail="Gemini analysis failed — check GEMINI_API_KEY and logs")

        return {"status": "ok", "analysis": analysis}

    return app


def start_api_server():
    try:
        import uvicorn
    except ImportError:
        log.error("uvicorn not installed. Run: pip install uvicorn")
        return
    app = create_app()
    if app:
        log.info(f"🌐 API server starting on http://{API_HOST}:{API_PORT}")
        uvicorn.run(app, host=API_HOST, port=API_PORT, log_level="warning")


if __name__ == "__main__":
    args     = set(sys.argv[1:])
    api_only = "--api-only" in args
    no_api   = "--no-api"   in args

    if api_only:
        start_api_server()
    elif no_api:
        run()
    else:
        poller_thread = threading.Thread(target=run, daemon=True)
        poller_thread.start()
        start_api_server()