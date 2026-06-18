import json
import os
import shutil
import sys
from pathlib import Path


def main() -> int:
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
        name = data["name"]
        cwd = Path(data["cwd"]).resolve()

        root = cwd / ".claude" / "worktrees"
        root.mkdir(parents=True, exist_ok=True)

        safe_name = name.replace('/', '+')
        worktree_path = (root / safe_name).resolve()

        if worktree_path.exists() and any(worktree_path.iterdir()):
            print(str(worktree_path))
            return 0

        if worktree_path.exists():
            shutil.rmtree(worktree_path)

        shutil.copytree(
            cwd,
            worktree_path,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns(
                '.claude',
                '__pycache__',
                '.pytest_cache',
                '.mypy_cache',
                '.ruff_cache',
                '.venv',
                'venv',
                'env',
                '.env',
                'node_modules',
                '.git',
            ),
        )

        print(str(worktree_path))
        return 0
    except Exception as e:
        print(f"WorktreeCreate failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
