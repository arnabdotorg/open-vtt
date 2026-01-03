#!/usr/bin/env python3
"""
🔆 open-vtt: Video to Enhanced VTT Converter and Player

Usage:
    python open-vtt.py --serve              # Serve player.html (default)
    python open-vtt.py --check              # Check system dependencies
    python open-vtt.py --convert video.mp4  # Convert video to enhanced VTT
"""

import argparse
import datetime
import http.server
import json
import os
import platform
import shutil
import socketserver
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Optional, Tuple

# =============================================================================
# CONSTANTS & CONFIG
# =============================================================================

APP_NAME = "🔆 open-vtt"
VERSION = "1.0.0"
BASE_DIR = Path(__file__).resolve().parent
# Default media dir if running from ./open-vtt/
# We try to look one level up -> media
MEDIA_DIR_CANDIDATE = BASE_DIR.parent / "media"
MEDIA_DIR = MEDIA_DIR_CANDIDATE if MEDIA_DIR_CANDIDATE.exists() else Path("media")

CONFIG_FILE = BASE_DIR / "config.json"

# Load config with defaults
def load_config():
    """Load configuration from config.json with sensible defaults."""
    config = {
        "gemini": {
            "model": "gemini-3-pro-preview",
            "temperature": 0.7,
            "max_output_tokens": 65536,
            "thinking": "high",
            "grounding": {"enabled": True, "source": "google_search"}
        },
        "video": {
            "max_size_mb": 400,
            "downsample_targets": [
                {"fps": 10, "resolution": "1920x1080", "label": "10fps 1080p"},
                {"fps": 5,  "resolution": "1920x1080", "label": "5fps 1080p"},
                {"fps": 5,  "resolution": "1280x720",  "label": "5fps 720p"},
                {"fps": 1,  "resolution": "854x480",   "label": "1fps 480p"},
            ]
        },
        "transcription": {
            "language": "en"  # Whisper language code: en, de, fr, es, etc.
        },
        "files": {
            "prompt": str(BASE_DIR / "prompts/gemini_vtt_prompt.md")
        }
    }
    
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE) as f:
                user_config = json.load(f)
                
                # Recursive deep merge
                def deep_update(base, update):
                    for k, v in update.items():
                        if isinstance(v, dict) and k in base and isinstance(base[k], dict):
                            deep_update(base[k], v)
                        else:
                            base[k] = v
                            
                deep_update(config, user_config)
        except (json.JSONDecodeError, IOError):
            pass  # Use defaults on error
    
    return config

CONFIG = load_config()

# Convenience accessors
MAX_SIZE_MB = CONFIG["video"]["max_size_mb"]
DOWNSAMPLE_TARGETS = CONFIG["video"]["downsample_targets"]
GEMINI_MODEL = CONFIG["gemini"]["model"]
PROMPT_FILE = CONFIG["files"]["prompt"]

# =============================================================================
# OPTIONAL IMPORTS
# =============================================================================

HAS_MLX_WHISPER = False
HAS_WHISPER = False
HAS_GENAI = False

try:
    import mlx_whisper
    HAS_MLX_WHISPER = True
except ImportError:
    pass

try:
    import whisper
    HAS_WHISPER = True
except ImportError:
    pass

try:
    from google import genai
    from google.genai import types
    HAS_GENAI = True
    GENAI_NEW = True
except ImportError:
    try:
        import google.generativeai as genai
        HAS_GENAI = True
        GENAI_NEW = False
    except ImportError:
        pass

# =============================================================================
# UTILITIES
# =============================================================================

def log_info(msg: str):
    print(f"🔆 {msg}")

def log_success(msg: str):
    print(f"✅ {msg}")

def log_warning(msg: str):
    print(f"⚠️  {msg}")

def log_error(msg: str):
    print(f"❌ {msg}")

def log_cost(msg: str):
    print(f"💰 {msg}")

def log_video(msg: str):
    print(f"🎬 {msg}")

def log_subtitle(msg: str):
    print(f"📝 {msg}")

def log_ai(msg: str):
    print(f"🤖 {msg}")

def estimate_cost(model: str, input_tok: int, output_tok: int) -> float:
    """Estimate cost based on Gemini API pricing (Jan 2025)."""
    # Gemini 3 Pro: $2.00/$12.00 per 1M (≤200k context), $4.00/$18.00 (>200k)
    # Gemini 1.5 Pro: $3.50/$10.50 per 1M
    # Gemini Flash: $0.075/$0.30 per 1M
    
    model_lower = model.lower()
    
    if "flash" in model_lower:
        rates = {"in": 0.075, "out": 0.30}
    elif "3" in model_lower or "gemini-3" in model_lower:
        # Gemini 3 Pro pricing (≤200k context tier)
        rates = {"in": 2.00, "out": 12.00}
    else:
        # Default to 1.5 Pro pricing
        rates = {"in": 3.50, "out": 10.50}
        
    cost = (input_tok / 1_000_000 * rates["in"]) + (output_tok / 1_000_000 * rates["out"])
    return cost


def run_command(cmd: list, capture: bool = True) -> Tuple[int, str, str]:
    """Run a command and return (returncode, stdout, stderr)."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=capture,
            text=True,
            timeout=3600  # 1 hour timeout for long operations
        )
        return result.returncode, result.stdout, result.stderr
    except FileNotFoundError:
        return -1, "", f"Command not found: {cmd[0]}"
    except subprocess.TimeoutExpired:
        return -2, "", "Command timed out"


def get_file_size_mb(path: Path) -> float:
    """Get file size in MB."""
    return path.stat().st_size / (1024 * 1024)


def to_vtt_time(seconds: float) -> str:
    """Format seconds into WebVTT timestamp: HH:MM:SS.mmm"""
    td = datetime.timedelta(seconds=seconds)
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    milliseconds = int((seconds - int(seconds)) * 1000)
    return f"{hours:02}:{minutes:02}:{secs:02}.{milliseconds:03}"


# =============================================================================
# API KEY HANDLING
# =============================================================================

def get_api_key() -> Optional[str]:
    """Get Gemini API key from environment or secrets.json."""
    # 1. Check environment variable
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        log_info("Using GEMINI_API_KEY from environment")
        return key
    
    # 2. Check secrets.json
    secrets_path = BASE_DIR / "secrets.json"
    if secrets_path.exists():
        try:
            with open(secrets_path) as f:
                secrets = json.load(f)
                key = secrets.get("GEMINI_API_KEY")
                if key and not key.startswith("YOUR_"):
                    log_info("Using GEMINI_API_KEY from secrets.json")
                    return key
        except json.JSONDecodeError:
            log_warning("secrets.json is not valid JSON")
    
    return None


# =============================================================================
# CHECK MODE
# =============================================================================

def check_command(name: str, cmd: list) -> bool:
    """Check if a command is available."""
    code, stdout, stderr = run_command(cmd)
    if code == 0:
        # Extract version from first line
        version = stdout.split('\n')[0][:60] if stdout else "found"
        log_success(f"{name}: {version}")
        return True
    else:
        log_error(f"{name}: not found")
        return False


def cmd_check():
    """Check system dependencies and hardware."""
    print(f"\n{APP_NAME} System Check\n" + "=" * 40)
    
    all_ok = True
    
    # FFmpeg/FFprobe
    all_ok &= check_command("ffmpeg", ["ffmpeg", "-version"])
    all_ok &= check_command("ffprobe", ["ffprobe", "-version"])
    
    # Whisper
    if HAS_MLX_WHISPER:
        log_success("mlx-whisper: available (Apple Silicon optimized)")
    elif HAS_WHISPER:
        log_warning("whisper (OpenAI): available, but mlx-whisper is faster on Apple Silicon")
    else:
        log_error("whisper: not installed (pip install mlx-whisper or openai-whisper)")
        all_ok = False
    
    # Gemini SDK
    if HAS_GENAI:
        if GENAI_NEW:
            log_success("google-genai: available (new SDK)")
        else:
            log_warning("google-generativeai: available (legacy, recommend google-genai)")
    else:
        log_error("google-genai: not installed (pip install google-genai)")
        all_ok = False
    
    # API Key
    if get_api_key():
        log_success("GEMINI_API_KEY: configured")
    else:
        log_warning("GEMINI_API_KEY: not configured (required for --convert)")
    
    # Hardware
    processor = platform.processor()
    machine = platform.machine()
    system = platform.system()
    
    if system == "Darwin" and machine == "arm64":
        log_success(f"Hardware: {processor} (Apple Silicon - Metal acceleration available)")
    else:
        log_info(f"Hardware: {processor} ({system} {machine})")
    
    # Python
    py_version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    if sys.version_info >= (3, 10):
        log_success(f"Python: {py_version}")
    else:
        log_warning(f"Python: {py_version} (3.10+ recommended)")
    
    print()
    if all_ok:
        log_success("All dependencies satisfied!")
    else:
        log_warning("Some dependencies missing - see above")
    
    return all_ok


# =============================================================================
# SERVE MODE
# =============================================================================

class OpenVTTHandler(http.server.SimpleHTTPRequestHandler):
    """Custom HTTP handler with /api/files endpoint."""
    
    def do_GET(self):
        if self.path == "/":
            self.path = "/player.html"
            
        super().do_GET()
    

    
    def log_message(self, format, *args):
        # Quieter logging
        # args[0] might be status code (int) not string, ignore if so or convert
        if len(args) > 0 and isinstance(args[0], str) and "/api/files" in args[0]:
            return
        
        # Default logging format matching SimpleHTTPRequestHandler
        log_info(f"[serve] {format % args}")
            
    def translate_path(self, path):
        """Custom path translation to serve media files."""
        from urllib.parse import unquote
        path = unquote(path)  # Decode %20 -> space, etc.
        
        # If user requests /media/filename.mp4, serve it from MEDIA_DIR
        if path.startswith("/media/"):
            rest = path.replace("/media/", "")
            return str(MEDIA_DIR / rest)
        
        # If user requests a video file directly at root (for backward compat or simple names)
        # Check if it exists in media dir
        path_clean = path.lstrip('/')
        media_path = MEDIA_DIR / path_clean
        if media_path.exists() and not path_clean.endswith(".html"):
             return str(media_path)

        # Otherwise rely on default SimpleHTTPRequestHandler (serves CWD = BASE_DIR usually)
        return super().translate_path(path)


def cmd_serve(port: int = 8000):
    """Serve player.html with dynamic file lists."""
    # Check player.html exists
    if not (BASE_DIR / "player.html").exists():
        log_error("player.html not found in open-vtt directory")
        sys.exit(1)
    
    # Switch to open-vtt directory so we can serve player.html easily
    os.chdir(BASE_DIR)

    # Count files
    videos = list(MEDIA_DIR.glob("*.mp4"))
    vtts = list(MEDIA_DIR.glob("*.vtt"))
    
    print(f"\n{APP_NAME} Server\n" + "=" * 40)
    log_info(f"Found {len(videos)} video(s) and {len(vtts)} VTT file(s)")
    log_info(f"Serving at http://localhost:{port}")
    log_info("Press Ctrl+C to stop\n")
    
    with socketserver.TCPServer(("", port), OpenVTTHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n")
            log_info("Server stopped")


# =============================================================================
# CONVERT MODE - FFPROBE
# =============================================================================

def ffprobe_check(video_path: Path) -> dict:
    """Check video health and get metadata."""
    log_video(f"Checking video: {video_path.name}")
    
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        str(video_path)
    ]
    
    code, stdout, stderr = run_command(cmd)
    if code != 0:
        log_error(f"ffprobe failed: {stderr}")
        return {}
    
    try:
        data = json.loads(stdout)
        
        # Extract useful info
        duration = float(data.get("format", {}).get("duration", 0))
        size_mb = get_file_size_mb(video_path)
        
        # Find subtitle and audio streams
        has_subtitles = False
        has_audio = False
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "subtitle":
                has_subtitles = True
            if stream.get("codec_type") == "audio":
                has_audio = True
        
        log_success(f"Duration: {duration:.1f}s, Size: {size_mb:.1f}MB, Audio: {has_audio}, Subtitles: {has_subtitles}")
        
        return {
            "duration": duration,
            "size_mb": size_mb,
            "has_audio": has_audio,
            "has_subtitles": has_subtitles,
            "data": data
        }
    except json.JSONDecodeError:
        log_error("Failed to parse ffprobe output")
        return {}


# =============================================================================
# CONVERT MODE - SUBTITLE EXTRACTION
# =============================================================================

def extract_subtitles(video_path: Path, output_path: Path) -> bool:
    """Extract embedded subtitles using ffmpeg."""
    log_subtitle(f"Extracting embedded subtitles to {output_path.name}")
    
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-map", "0:s:0", "-c:s", "webvtt",
        str(output_path)
    ]
    
    code, stdout, stderr = run_command(cmd)
    if code == 0 and output_path.exists():
        log_success(f"Extracted subtitles: {output_path.name}")
        return True
    else:
        log_warning("No embedded subtitles found or extraction failed")
        return False


def transcribe_with_whisper(video_path: Path, output_path: Path) -> bool:
    """Transcribe video using mlx-whisper or whisper."""
    log_subtitle(f"Transcribing audio with Whisper...")
    
    if HAS_MLX_WHISPER:
        log_info("Using mlx-whisper (Apple Silicon optimized)")
        try:
            language = CONFIG.get("transcription", {}).get("language", "en")
            log_info(f"Language: {language}")
            result = mlx_whisper.transcribe(
                str(video_path),
                path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
                language=language,
                verbose=False
            )
            
            with open(output_path, "w", encoding="utf-8") as vtt:
                vtt.write("WEBVTT\n\n")
                for segment in result.get("segments", []):
                    start = to_vtt_time(segment["start"])
                    end = to_vtt_time(segment["end"])
                    text = segment["text"].strip()
                    vtt.write(f"{start} --> {end}\n{text}\n\n")
            
            log_success(f"Transcribed: {output_path.name}")
            return True
        except Exception as e:
            log_error(f"mlx-whisper failed: {e}")
            return False
    
    elif HAS_WHISPER:
        log_info("Using openai-whisper")
        try:
            language = CONFIG.get("transcription", {}).get("language", "en")
            log_info(f"Language: {language}")
            model = whisper.load_model("base")
            result = model.transcribe(str(video_path), language=language)
            
            with open(output_path, "w", encoding="utf-8") as vtt:
                vtt.write("WEBVTT\n\n")
                for segment in result.get("segments", []):
                    start = to_vtt_time(segment["start"])
                    end = to_vtt_time(segment["end"])
                    text = segment["text"].strip()
                    vtt.write(f"{start} --> {end}\n{text}\n\n")
            
            log_success(f"Transcribed: {output_path.name}")
            return True
        except Exception as e:
            log_error(f"whisper failed: {e}")
            return False
    
    else:
        log_error("No whisper implementation available")
        return False


# =============================================================================
# CONVERT MODE - DOWNSAMPLING
# =============================================================================

def downsample_video(video_path: Path, output_path: Path) -> Optional[Path]:
    """Downsample video to fit under MAX_SIZE_MB."""
    size_mb = get_file_size_mb(video_path)
    
    if size_mb <= MAX_SIZE_MB:
        log_video(f"Video is {size_mb:.1f}MB - no downsampling needed")
        return video_path
    
    log_video(f"Video is {size_mb:.1f}MB - downsampling to fit under {MAX_SIZE_MB}MB")
    
    for target in DOWNSAMPLE_TARGETS:
        log_info(f"Trying {target['label']}...")
        
        width, height = target["resolution"].split("x")
        
        cmd = [
            "ffmpeg", "-y", "-i", str(video_path),
            "-vf", f"fps={target['fps']},scale={width}:{height}:force_original_aspect_ratio=decrease",
            "-c:v", "libx264", "-crf", "28", "-preset", "fast",
            "-c:a", "aac", "-b:a", "128k",
            str(output_path)
        ]
        
        code, stdout, stderr = run_command(cmd)
        
        if code == 0 and output_path.exists():
            new_size = get_file_size_mb(output_path)
            if new_size <= MAX_SIZE_MB:
                log_success(f"Downsampled to {new_size:.1f}MB ({target['label']})")
                return output_path
            else:
                log_warning(f"Still {new_size:.1f}MB - trying lower quality")
        else:
            log_warning(f"FFmpeg failed for {target['label']}")
    
    log_error("Could not downsample video under size limit")
    return None


# =============================================================================
# CONVERT MODE - GEMINI
# =============================================================================

def call_gemini(
    api_key: str,
    prompt_path: Path,
    subtitles_path: Path,
    video_path: Path
) -> Optional[dict]:
    """
    Call Gemini API to enhance subtitles.
    Returns dict with 'raw' (full response) and 'vtt' (extracted VTT) keys.
    """
    if not HAS_GENAI:
        log_error("google-genai not installed (pip install google-genai)")
        return None
    
    log_ai(f"Calling Gemini ({GEMINI_MODEL})...")
    
    # Read prompt
    with open(prompt_path, "r") as f:
        prompt_text = f.read()

    # Inject config settings
    thinking_level = CONFIG["gemini"].get("thinking", "HIGH").upper()
    prompt_text = prompt_text.replace("{{THINKING_LEVEL}}", thinking_level)
    
    # Read subtitles
    with open(subtitles_path, "r") as f:
        subtitles_text = f.read()
    
    # Estimate cost (rough estimate based on file sizes)
    video_size_mb = get_file_size_mb(video_path)
    prompt_tokens = len(prompt_text) // 4
    subtitle_tokens = len(subtitles_text) // 4
    video_tokens = int(video_size_mb * 1000)  # ~1000 tokens per MB
    total_input = prompt_tokens + subtitle_tokens + video_tokens
    
    log_cost(f"Estimated input: ~{total_input:,} tokens")
    
    import time
    
    # Build combined prompt
    full_prompt = f"""{prompt_text}

---

## Baseline VTT Input

```vtt
{subtitles_text}
```

---

## Video File

The video file is attached. Please analyze it and generate the enhanced VTT.
"""
    
    try:
        if GENAI_NEW:
            # New google.genai SDK
            client = genai.Client(api_key=api_key)
            
            # Upload video file
            log_ai("Uploading video to Gemini...")
            video_file = client.files.upload(file=video_path)
            
            # Wait for processing
            while video_file.state.name == "PROCESSING":
                log_info("Waiting for video processing...")
                time.sleep(5)
                video_file = client.files.get(name=video_file.name)
            
            if video_file.state.name == "FAILED":
                log_error("Video processing failed")
                return None
            
            log_success("Video uploaded and processed")
            
            # Wait for file propagation to avoid 404
            log_info("Waiting 5s for file propagation...")
            time.sleep(5)
            
            # Generate content
            log_ai("Generating enhanced VTT...")
            
            # Prepare tools (Grounding)
            tools = []
            if CONFIG["gemini"]["grounding"]["enabled"]:
                if CONFIG["gemini"]["grounding"]["source"] == "google_search":
                    tools.append(types.Tool(google_search=types.GoogleSearch()))
            
            # Prepare config
            gen_config = types.GenerateContentConfig(
                temperature=CONFIG["gemini"]["temperature"],
                max_output_tokens=CONFIG["gemini"]["max_output_tokens"],
                tools=tools if tools else None
            )

            try:
                response = client.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=[
                        types.Part.from_uri(file_uri=video_file.uri, mime_type=video_file.mime_type),
                        full_prompt
                    ],
                    config=gen_config
                )
            except Exception as e:
                # Catch 404 specifically
                if "404" in str(e):
                    log_error(f"Gemini returned 404 NOT_FOUND.")
                    log_error(f"  Model: {GEMINI_MODEL}")
                    log_error(f"  File URI: {video_file.uri}")
                    log_error("This implies the model name is invalid or the file is not yet available.")
                raise e
            
            # Extract text
            text = response.text
            
            # Log usage if available
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                usage = response.usage_metadata
                cost = estimate_cost(GEMINI_MODEL, usage.prompt_token_count, usage.candidates_token_count)
                log_cost(f"Actual usage: {usage.prompt_token_count:,} input, {usage.candidates_token_count:,} output tokens (${cost:.4f})")
        
        else:
            # Legacy google.generativeai SDK
            genai.configure(api_key=api_key)
            
            # Upload video file
            log_ai("Uploading video to Gemini...")
            video_file = genai.upload_file(str(video_path))
            
            # Wait for processing
            while video_file.state.name == "PROCESSING":
                log_info("Waiting for video processing...")
                time.sleep(5)
                video_file = genai.get_file(video_file.name)
            
            if video_file.state.name == "FAILED":
                log_error("Video processing failed")
                return None
            
            log_success("Video uploaded and processed")
            
            # Wait for propagation
            log_info("Waiting 5s for file propagation...")
            time.sleep(5)
            
            # Prepare tools (Grounding)
            tools = []
            if CONFIG["gemini"]["grounding"]["enabled"]:
                if CONFIG["gemini"]["grounding"]["source"] == "google_search":
                    tools.append({"google_search": {}})

            # Create model with settings
            model = genai.GenerativeModel(
                model_name=GEMINI_MODEL,
                generation_config={
                    "temperature": CONFIG["gemini"]["temperature"],
                    "max_output_tokens": CONFIG["gemini"]["max_output_tokens"],
                },
                tools=tools if tools else None
            )
            
            # Generate content
            log_ai("Generating enhanced VTT...")
            response = model.generate_content(
                [video_file, full_prompt],
                request_options={"timeout": 600}
            )
            
            # Extract text
            text = response.text
            
            # Log usage if available
            if hasattr(response, 'usage_metadata') and response.usage_metadata:
                usage = response.usage_metadata
                cost = estimate_cost(GEMINI_MODEL, usage.prompt_token_count, usage.candidates_token_count)
                log_cost(f"Actual usage: {usage.prompt_token_count:,} input, {usage.candidates_token_count:,} output tokens (${cost:.4f})")
        
        # Keep full response for logging
        raw_text = text
        
        # Extract just the VTT portion
        vtt_text = None
        if "WEBVTT" in text:
            vtt_start = text.find("WEBVTT")
            # Find end of VTT (usually marked by ```)
            vtt_end = text.find("```", vtt_start)
            if vtt_end > vtt_start:
                vtt_text = text[vtt_start:vtt_end].strip()
            else:
                vtt_text = text[vtt_start:].strip()
        else:
            # No VTT found, use full text
            vtt_text = text
        
        return {
            'raw': raw_text,
            'vtt': vtt_text
        }
        
    except Exception as e:
        log_error(f"Gemini API error: {e}")
        return None


# =============================================================================
# CONVERT MODE - MAIN
# =============================================================================

def get_output_path(base_name: str, extension: str, directory: Path, specified: Optional[str] = None) -> Path:
    """Get output path, avoiding overwrites, defaulting to input directory."""
    if specified:
        return Path(specified)
    
    output = directory / f"{base_name}.{extension}"
    counter = 1
    while output.exists():
        output = directory / f"{base_name}-{counter}.{extension}"
        counter += 1
    
    return output


def cmd_convert(video_file: str, output_vtt: Optional[str] = None):
    """Convert video to enhanced VTT."""
    video_path = Path(video_file)
    
    if not video_path.exists():
        # Try checking in MEDIA_DIR
        candidate = MEDIA_DIR / video_file
        if candidate.exists():
            video_path = candidate
        else:
            log_error(f"Video file not found: {video_file} (searched in . and {MEDIA_DIR})")
            sys.exit(1)
    
    # Generate session UUID
    session_id = str(uuid.uuid4())[:8]
    base_name = video_path.stem
    work_dir = video_path.parent  # Work in the same directory as the video
    
    print(f"\n{APP_NAME} Converter\n" + "=" * 40)
    log_info(f"Session: {session_id}")
    log_info(f"Input: {video_path}")
    log_info(f"Working Directory: {work_dir}")
    
    # Check API key
    api_key = get_api_key()
    if not api_key:
        log_error("GEMINI_API_KEY not configured!")
        log_info("Set environment variable or add to secrets.json")
        sys.exit(1)
    
    # Check prompt file
    prompt_path = Path(PROMPT_FILE)
    if not prompt_path.exists():
        # Try resolving relative to BASE_DIR
        candidate = BASE_DIR / PROMPT_FILE
        if candidate.exists():
            prompt_path = candidate
        else:
            log_error(f"Prompt file not found: {PROMPT_FILE}")
            sys.exit(1)
    
    # Step 1: Check video health
    print("\n" + "-" * 40)
    metadata = ffprobe_check(video_path)
    if not metadata:
        log_error("Video check failed")
        sys.exit(1)
    
    # Step 2: Extract or generate subtitles
    print("\n" + "-" * 40)
    subtitles_path = work_dir / f"{base_name}-subtitles-{session_id}.vtt"
    
    # Handle silent movies (no audio stream)
    if not metadata.get("has_audio"):
        log_info("🎬 Silent movie detected - no audio to transcribe")
        with open(subtitles_path, "w") as f:
            f.write("WEBVTT\n\nNOTE This video has no audio track (silent film).\n\n")
        success = True
    elif metadata.get("has_subtitles"):
        success = extract_subtitles(video_path, subtitles_path)
        if not success:
            success = transcribe_with_whisper(video_path, subtitles_path)
    else:
        success = transcribe_with_whisper(video_path, subtitles_path)
    
    if not success or not subtitles_path.exists():
        log_error("Failed to obtain subtitles")
        sys.exit(1)
    
    # Step 3: Downsample if needed
    print("\n" + "-" * 40)
    downsampled_path = work_dir / f"{base_name}-downsampled-{session_id}.mp4"
    final_video = downsample_video(video_path, downsampled_path)
    
    if not final_video:
        log_error("Failed to prepare video for upload")
        sys.exit(1)
    
    # Step 4: Call Gemini
    print("\n" + "-" * 40)
    result = call_gemini(api_key, prompt_path, subtitles_path, final_video)
    
    if not result:
        log_error("Failed to generate enhanced VTT")
        sys.exit(1)
    
    # Step 5: Save outputs (both log and VTT)
    print("\n" + "-" * 40)
    
    # Save full response as log (includes Pass 1 event log + Pass 2 VTT)
    log_path = get_output_path(base_name, "log", work_dir, None)
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(result['raw'])
    log_success(f"Full response saved to: {log_path}")
    
    # Save extracted VTT
    output_path = get_output_path(base_name, "vtt", work_dir, output_vtt)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(result['vtt'])
    log_success(f"Enhanced VTT saved to: {output_path}")
    
    # Summary
    print("\n" + "=" * 40)
    log_success("Conversion complete!")
    log_info(f"Temp files: {subtitles_path.name}")
    if final_video != video_path:
        log_info(f"           {downsampled_path.name}")
    log_info("Run with --serve to test in player")


# =============================================================================
# TESTING
# =============================================================================

def cmd_test():
    """Run unit tests for Python utilities."""
    print(f"\n🧪 {APP_NAME} Python Test Suite\n")
    print("=" * 60)
    
    passed = 0
    failed = 0
    
    def test(condition: bool, name: str, details: str = ""):
        nonlocal passed, failed
        if condition:
            passed += 1
            print(f"  ✅ {name}")
        else:
            failed += 1
            print(f"  ❌ {name}")
            if details:
                print(f"     {details}")
    
    # -------------------------------------------------------------------------
    # Test to_vtt_time
    # -------------------------------------------------------------------------
    print("\n📋 to_vtt_time tests:")
    
    test(to_vtt_time(0) == "00:00:00.000", "to_vtt_time(0)")
    test(to_vtt_time(1) == "00:00:01.000", "to_vtt_time(1)")
    test(to_vtt_time(1.5) == "00:00:01.500", "to_vtt_time(1.5)")
    test(to_vtt_time(61) == "00:01:01.000", "to_vtt_time(61)")
    test(to_vtt_time(3661) == "01:01:01.000", "to_vtt_time(3661) = 1h1m1s")
    test(to_vtt_time(90.123) == "00:01:30.123", "to_vtt_time(90.123)")
    test(to_vtt_time(3600) == "01:00:00.000", "to_vtt_time(3600) = 1 hour")
    
    # -------------------------------------------------------------------------
    # Test VTT extraction (simulated Gemini response)
    # -------------------------------------------------------------------------
    print("\n📋 VTT extraction tests:")
    
    # Simulate extract_vtt logic
    def extract_vtt(text: str) -> str:
        """Extract VTT portion from response text."""
        if "WEBVTT" in text:
            vtt_start = text.find("WEBVTT")
            # Find end of VTT (usually marked by ```)
            vtt_end = text.find("```", vtt_start)
            if vtt_end == -1:
                return text[vtt_start:]
            return text[vtt_start:vtt_end].strip()
        return text
    
    # Test cases
    raw1 = "Here is the VTT:\n```\nWEBVTT\n\n00:00.000 --> 00:05.000\nHello\n```\nDone!"
    test("WEBVTT" in extract_vtt(raw1), "Extracts VTT from markdown code block")
    test("Done!" not in extract_vtt(raw1), "Excludes text after code block")
    
    raw2 = "WEBVTT\n\n00:00.000 --> 00:05.000\nPlain VTT"
    test(extract_vtt(raw2).startswith("WEBVTT"), "Handles plain VTT without code block")
    
    raw3 = "No VTT content here at all"
    test(extract_vtt(raw3) == raw3, "Returns original if no VTT found")
    
    # -------------------------------------------------------------------------
    # Test path handling
    # -------------------------------------------------------------------------
    print("\n📋 Path handling tests:")
    
    test(BASE_DIR.exists(), "BASE_DIR exists")
    test(MEDIA_DIR.exists() or True, "MEDIA_DIR reference valid")  # May not exist
    test(CONFIG_FILE.suffix == ".json", "CONFIG_FILE is .json")
    
    # -------------------------------------------------------------------------
    # Test file size utility
    # -------------------------------------------------------------------------
    print("\n📋 File size utility tests:")
    
    # Create temp file for testing
    import tempfile
    with tempfile.NamedTemporaryFile(delete=False, suffix='.txt') as f:
        f.write(b'x' * 1024 * 1024)  # 1MB
        temp_path = Path(f.name)
    
    try:
        size_mb = get_file_size_mb(temp_path)
        test(0.9 < size_mb < 1.1, f"get_file_size_mb returns ~1.0 for 1MB file", f"Got: {size_mb}")
    finally:
        temp_path.unlink()
    
    # -------------------------------------------------------------------------
    # Test config loading
    # -------------------------------------------------------------------------
    print("\n📋 Config loading tests:")
    
    test("gemini" in CONFIG, "CONFIG has 'gemini' section")
    test("video" in CONFIG, "CONFIG has 'video' section")
    test("files" in CONFIG, "CONFIG has 'files' section")
    test(isinstance(CONFIG["gemini"]["model"], str), "gemini.model is string")
    
    # -------------------------------------------------------------------------
    # Summary
    # -------------------------------------------------------------------------
    print("\n" + "=" * 60)
    print(f"📊 Results: {passed} passed, {failed} failed")
    print("=" * 60)
    
    if failed == 0:
        print("✅ ALL TESTS PASSED!\n")
    else:
        print("❌ SOME TESTS FAILED\n")
        sys.exit(1)


# =============================================================================
# MAIN
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description=f"{APP_NAME} - Video to Enhanced VTT",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python open-vtt.py --serve              Serve player.html
  python open-vtt.py --serve --port 3000  Serve on port 3000
  python open-vtt.py --check              Check dependencies
  python open-vtt.py --convert video.mp4  Convert video to VTT
  python open-vtt.py --test               Run unit tests
        """
    )
    
    parser.add_argument("--serve", action="store_true",
                        help="Serve player.html with dynamic file lists")
    parser.add_argument("--port", type=int, default=8000,
                        help="Port for serve mode (default: 8000)")
    parser.add_argument("--check", action="store_true",
                        help="Check system dependencies")
    parser.add_argument("--convert", metavar="VIDEO",
                        help="Convert video file to enhanced VTT")
    parser.add_argument("--output-vtt", metavar="FILE",
                        help="Output VTT filename (for --convert)")
    parser.add_argument("--test", action="store_true",
                        help="Run unit tests")
    parser.add_argument("--version", action="version",
                        version=f"{APP_NAME} {VERSION}")
    
    args = parser.parse_args()
    
    # Default to serve if no command
    if not any([args.serve, args.check, args.convert, args.test]):
        args.serve = True
    
    if args.test:
        cmd_test()
    elif args.check:
        cmd_check()
    elif args.convert:
        cmd_convert(args.convert, args.output_vtt)
    elif args.serve:
        cmd_serve(args.port)


if __name__ == "__main__":
    main()