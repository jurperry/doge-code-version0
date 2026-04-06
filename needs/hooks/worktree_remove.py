import json
import shutil
import sys
from pathlib import Path


def main() -> int:
    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
        worktree_path = Path(data["worktree_path"]).resolve()

        if worktree_path.exists():
            shutil.rmtree(worktree_path)

        return 0
    except Exception as e:
        print(f"WorktreeRemove failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
