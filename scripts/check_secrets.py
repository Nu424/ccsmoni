"""コミット前の機密チェック。

何を: ステージされたファイル（または --all で追跡対象すべて）に、禁止語が含まれていないかを調べる。
なぜ: エイリアス名・パス・ホスト名などの実環境情報をリポジトリに入れないため。人の注意力ではなく仕組みで防ぐ。
方針: 禁止語は git 管理外の local/secret-words.txt に置く（このスクリプト自体に機密を書かない）。
      リストがない環境（他の人の clone など）では何もせずに通す。
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORDS_FILE = ROOT / "local" / "secret-words.txt"


def compile_word(w: str) -> re.Pattern[str]:
    # 英数字の前後が英数字に続いていないときだけ一致させる（"countLabel" の中の語に誤反応しないため）
    return re.compile(rf"(?<![a-z0-9]){re.escape(w)}(?![a-z0-9])", re.IGNORECASE)


def load_words() -> list[str]:
    if not WORDS_FILE.exists():
        return []
    words = []
    for line in WORDS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            words.append(line.lower())
    return words


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True
    ).stdout


def target_files(check_all: bool) -> list[str]:
    if check_all:
        out = git("ls-files")
    else:
        out = git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
    return [p for p in out.splitlines() if p]


def read_content(path: str, check_all: bool) -> str:
    # ステージ版（:path）を読む。作業ツリーとステージがずれていても、実際にコミットされる中身を調べる
    try:
        if check_all:
            return (ROOT / path).read_text(encoding="utf-8", errors="replace")
        return git("show", f":{path}")
    except (OSError, subprocess.CalledProcessError, UnicodeDecodeError):
        return ""


def main() -> int:
    check_all = "--all" in sys.argv
    words = load_words()
    if not words:
        return 0

    patterns = [compile_word(w) for w in words]
    hits: list[str] = []
    for path in target_files(check_all):
        # ファイル名自体もチェック対象
        for i, pat in enumerate(patterns, 1):
            if pat.search(path):
                hits.append(f"{path}: (ファイル名) 禁止語 #{i}")
        for lineno, line in enumerate(read_content(path, check_all).splitlines(), 1):
            for i, pat in enumerate(patterns, 1):
                if pat.search(line):
                    # 禁止語そのものは表示しない（ログに残さないため）。リストでの番号で示す
                    hits.append(f"{path}:{lineno}: 禁止語 #{i}")

    if hits:
        print("[check_secrets] 機密情報の可能性がある記述が見つかりました。コミットを中止します。", file=sys.stderr)
        for h in hits:
            print("  " + h, file=sys.stderr)
        print("  （禁止語の一覧: local/secret-words.txt）", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
