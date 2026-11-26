import re

from praide import PraideError, files

_PATH_RE = re.compile(
    r"(?<![\w])(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9_-]+)?(?![\w])"
    r"|(?<![\w])[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+(?![\w])"
)
_QUOTED_PATH_RE = re.compile(r"[`\"']([^`\"'\r\n]+)[`\"']")
_COMMON_BARE_FILES = {
    "brewfile",
    "cmakelists",
    "dockerfile",
    "gemfile",
    "justfile",
    "license",
    "makefile",
    "procfile",
    "taskfile",
    "vagrantfile",
}
_SECRET_NAMES = (".npmrc", ".pypirc")
_GENERATED_DIRS = {
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "vendor",
}


def path_key(path):
    return path.replace("\\", "/").casefold()


def is_safe_project_path(path):
    if not isinstance(path, str) or not path or "\0" in path:
        return False
    normalized = path.replace("\\", "/")
    if normalized.startswith("/") or ":" in normalized:
        return False
    components = normalized.split("/")
    if any(not part or part in {".", ".."} for part in components):
        return False
    if any(
        part.casefold() in {".git", ".praide"} | _GENERATED_DIRS for part in components
    ):
        return False
    for component in components:
        name = component.casefold()
        if (
            name == ".env"
            or name.startswith(".env.")
            or name in _SECRET_NAMES
            or name.startswith("id_rsa")
            or name.startswith("id_ed25519")
            or name.endswith((".pem", ".key", ".p12", ".pfx"))
        ):
            return False
    return True


def unique_paths(paths):
    unique = []
    seen = set()
    for path in paths:
        if not isinstance(path, str):
            continue
        normalized = path.strip().strip("\"'`").rstrip(".,;:!?)]}").strip("([{")
        normalized = normalized.replace("\\", "/")
        while normalized.startswith("./"):
            normalized = normalized[2:]
        if not normalized:
            continue
        key = path_key(normalized)
        if key not in seen:
            seen.add(key)
            unique.append(normalized)
    return unique


def paths_in_text(text):
    text = text or ""
    matches = [match.group(0).rstrip(".,;:!?)]}") for match in _PATH_RE.finditer(text)]
    for match in _QUOTED_PATH_RE.finditer(text):
        candidate = match.group(1).strip()
        basename = candidate.replace("\\", "/").rsplit("/", 1)[-1]
        if (
            "/" in candidate
            or "\\" in candidate
            or "." in basename
            or basename.casefold() in _COMMON_BARE_FILES
        ):
            matches.append(candidate)
    return unique_paths(matches)


def budget_for_context(context_limit):
    limit = (
        context_limit
        if isinstance(context_limit, int) and context_limit > 0
        else 16_000
    )
    max_tokens = min(1_200, max(1, limit // 8))
    remaining_tokens = max(0, limit - max_tokens)
    return {
        "context_limit": limit,
        "max_tokens": max_tokens,
        "file_chars": int(remaining_tokens * 3 * 0.60),
    }


class FileCollector:
    def __init__(self):
        self.attempted = set()
        self.rejected = set()

    def read(self, path, max_bytes):
        normalized = path.replace("\\", "/")
        key = path_key(normalized)
        if key in self.attempted or not is_safe_project_path(normalized):
            self.attempted.add(key)
            return None
        self.attempted.add(key)
        try:
            return files.read(normalized, max_bytes=max(1, max_bytes))
        except PraideError:
            self.rejected.add(key)
            return None

    def read_paths(self, paths, budget_chars, refresh=False):
        unique = unique_paths(paths)
        files_by_path = {}
        used = 0
        candidates = [
            path
            for path in unique
            if is_safe_project_path(path)
            and (refresh or path_key(path) not in self.attempted)
            and path_key(path) not in self.rejected
        ]
        if refresh:
            candidates = [
                path for path in unique if path_key(path) not in self.rejected
            ]
        remaining = max(0, budget_chars)
        for index, path in enumerate(candidates):
            if remaining <= 0:
                break
            allowance = max(1, remaining // (len(candidates) - index))
            record = (
                self.read(path, allowance)
                if not refresh
                else self._refresh(path, allowance)
            )
            if record is None:
                continue
            files_by_path[record["path"]] = record
            actual = len(record["text"])
            used += actual
            remaining = max(0, remaining - actual)
        return {"files": files_by_path, "paths": list(files_by_path), "used": used}

    def _refresh(self, path, max_bytes):
        key = path_key(path)
        self.attempted.add(key)
        try:
            return files.read(path, max_bytes=max(1, max_bytes))
        except PraideError:
            self.rejected.add(key)
            return None


def project_listing():
    root = files.list("")
    lines = []
    directories = []
    count = 0
    for entry in root:
        if count == 200:
            break
        name = entry.get("name")
        kind = entry.get("kind")
        if not isinstance(name, str):
            continue
        path = name
        if not is_safe_project_path(path):
            continue
        lines.append(f"{'[dir]' if kind == 'dir' else '[file]'} {path}")
        count += 1
        if kind == "dir":
            directories.append(path)
    for directory in directories:
        if count >= 200:
            break
        try:
            children = files.list(directory)
        except PraideError:
            continue
        for entry in children:
            if count >= 200:
                break
            name = entry.get("name")
            kind = entry.get("kind")
            path = f"{directory}/{name}" if isinstance(name, str) else ""
            if not path or not is_safe_project_path(path):
                continue
            lines.append(f"{'[dir]' if kind == 'dir' else '[file]'} {path}")
            count += 1
    return "\n".join(lines) or "(no project files listed)"
