#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
念语（Nianyu）自动推送脚本 —— 不依赖 git 协议（沙箱阻断 git push 时可用 REST API 直达）。

设计要点（踩坑后修正）：
1. 必须带 User-Agent 头，否则 GitHub 偶发返回 404（误判 token 失效）。
2. 构建新 tree 时用 base_tree = 远端当前 tree，再把本地文件作为覆盖项叠加。
   → 远端独有的文件（如已删除的 mp3 不会"复活"）永远保留，不会丢内容。
3. 新 commit 的 parent = 远端 main 当前 SHA，属于快进，无需 --force。
4. 沙箱代理偶发 404/502/503/429 自动重试（最多 5 次，指数退避）。
5. 推送后校验远端 mp3 数量 = 0（版权安全闸），若异常则报警但不自动回滚。

用法：
  python scripts/push-remote.py -m "feat: xxx"            # 先提交工作区改动，再推送
  python scripts/push-remote.py -m "feat: xxx" --tag      # 推送并打 v<package.json 版本> tag
  python scripts/push-remote.py --only-push -m "msg"      # 不自动提交，仅推送已 commit 的内容
  python scripts/push-remote.py -m "msg" --dry-run        # 只构建 tree，不写远端

token 来源（按序）：环境变量 NIANYU_GH_TOKEN / 参数 --token / 文件 .git/nianyu/token
（token 文件已被 .gitignore 排除，不会进仓）
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPO = "qufang888/Nianyu-Chat"
API = f"https://api.github.com/repos/{REPO}"
DEFAULT_TOKEN_PATH = os.path.join(".git", "nianyu", "token")


def log(*a):
    print(*a, flush=True)


def load_token(args, repo_root):
    if args.token:
        return args.token
    env = os.environ.get("NIANYU_GH_TOKEN")
    if env:
        return env
    p = args.token_path or os.path.join(repo_root, DEFAULT_TOKEN_PATH)
    if os.path.exists(p):
        return open(p, encoding="utf-8").read().strip()
    log("❌ 找不到 GitHub token（检查 .git/nianyu/token 或设置 NIANYU_GH_TOKEN）")
    sys.exit(1)


def req(token, method, path, payload=None, _try=0):
    body = json.dumps(payload).encode() if payload is not None else None
    q = urllib.request.Request(API + path, data=body, method=method)
    q.add_header("Authorization", "Bearer " + token)
    q.add_header("Accept", "application/vnd.github+json")
    q.add_header("X-GitHub-Api-Version", "2022-11-28")
    q.add_header("User-Agent", "nianyu-push")  # 缺这个头 GitHub 会偶发 404
    if body:
        q.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(q, timeout=180) as x:
            t = x.read().decode()
            return x.status, (json.loads(t) if t.strip() else {})
    except urllib.error.HTTPError as e:
        code = e.code
        if code in (404, 502, 503, 429) and _try < 5:
            time.sleep(1.5 * (_try + 1))
            return req(token, method, path, payload, _try + 1)
        return code, {"__err": e.read().decode()[:300]}
    except Exception as e:  # 网络抖动
        if _try < 5:
            time.sleep(1.5 * (_try + 1))
            return req(token, method, path, payload, _try + 1)
        return 0, {"__err": repr(e)}


def git(args):
    # v2.3.126：显式 UTF-8 解码 + surrogateescape —— 仓库里有中文文件名（使用说明.md 等），
    # 若按系统 locale（中文 Windows 常见为 cp936）解码会变成乱码，导致后续按路径读文件失败。
    return subprocess.run(
        ["git", "-c", "core.quotepath=false"] + args,
        capture_output=True, text=True, encoding="utf-8", errors="surrogateescape", check=True,
    ).stdout


def git_bytes(args):
    """取 git 对象库的**原始字节**（不做任何换行/编码转换）"""
    return subprocess.run(
        ["git", "-c", "core.quotepath=false"] + args,
        capture_output=True, check=True,
    ).stdout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-m", "--message", help="提交信息（自动提交工作区或为新 commit 命名）")
    ap.add_argument("--only-push", action="store_true", help="不自动提交，仅推送已 commit 内容")
    ap.add_argument("--tag", action="store_true", help="推送后打 v<package.json 版本> tag")
    ap.add_argument("--no-tag", action="store_true", help="强制不打 tag")
    ap.add_argument("--dry-run", action="store_true", help="只构建 tree，不写远端")
    ap.add_argument("--token", help="直接传 token（不推荐，会进 shell 历史）")
    ap.add_argument("--token-path", help="token 文件路径，默认 .git/nianyu/token")
    args = ap.parse_args()

    repo_root = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                               capture_output=True, text=True, check=True).stdout.strip()
    token = load_token(args, repo_root)
    os.chdir(repo_root)

    # 1) 可选：自动提交工作区改动
    if not args.only_push:
        status = git(["status", "--porcelain"])
        if status.strip():
            if not args.message:
                log("❌ 工作区有改动但未提供 -m，无法自动提交")
                sys.exit(1)
            git(["add", "-A"])
            git(["commit", "-q", "-m", args.message])
            log("✅ 已提交工作区改动")
        else:
            log("ℹ️ 工作区干净，无需提交")
    else:
        if git(["status", "--porcelain"]).strip():
            log("⚠️ 工作区有未提交改动（--only-push 模式不会提交它们，远端将不含这些改动）")

    # 2) 取远端 main + tree（作为 base_tree，保留远端独有内容）
    st, ref = req(token, "GET", "/git/ref/heads/main")
    if st != 200:
        log("❌ 取远端 main 失败:", st, ref)
        sys.exit(1)
    parent = ref["object"]["sha"]
    st, cm = req(token, "GET", f"/git/commits/{parent}")
    if st != 200:
        log("❌ 取远端 commit 失败:", st, cm)
        sys.exit(1)
    base_tree = cm["tree"]["sha"]
    log(f"远端 main = {parent[:10]}  tree = {base_tree[:10]}")

    # 3) 列本地已 commit 文件 → 从 **git 对象库**取已提交内容建 blob
    #    v2.3.126 修正：旧实现读**工作区字节**造 blob。本仓库 core.autocrlf 生效时工作区是
    #    CRLF、git 存的是 LF 规范化内容 → 上传的 blob 与本地 commit 的 blob 根本不是同一个对象
    #    （sha 不同）→ ①远端 tree 与本地 commit 逐字节不一致；②这类 blob 在建 tree 时会**偶发**
    #    422（tree.sha xxx is not a valid blob —— 同一 blob 换个路径重试即成功，属 GitHub 对
    #    新建 blob 的可见性延迟），而旧脚本对 422 没有任何重试 → 发版直接失败。
    #    现改为：mode/sha 直接取自 `git ls-tree`（保留 100755 可执行位），内容取自
    #    `git cat-file blob <sha>`（= 已提交的规范化字节）→ 上传得到的 sha 与本地 sha 必然一致
    #    → 远端 tree == 本地 commit tree（逐字节一致），并顺带保住可执行位。
    tree_lines = [l for l in git(["ls-tree", "-r", "HEAD"]).split("\n") if l.strip()]
    log(f"本地文件数 = {len(tree_lines)}")
    entries = []
    uploaded = []  # (path, sha, content) —— 建 tree 失败重传时复用
    for i, line in enumerate(tree_lines):
        meta, path = line.split("\t", 1)
        mode, otype, osha = meta.split()
        if otype != "blob":
            continue
        data = git_bytes(["cat-file", "blob", osha])
        st, blob = req(token, "POST", "/git/blobs",
                       {"content": base64.b64encode(data).decode(), "encoding": "base64"})
        if st not in (200, 201):
            log(f"❌ blob 失败 {path}: {st} {blob}")
            sys.exit(1)
        if blob.get("sha") != osha:
            log(f"❌ blob 内容与本地 commit 不一致 {path}: 本地 {osha[:10]} vs 远端 {str(blob.get('sha'))[:10]}")
            sys.exit(1)
        entries.append({"path": path, "mode": mode, "type": "blob", "sha": osha})
        uploaded.append((path, osha, data))
        if (i + 1) % 60 == 0:
            log(f"  blob {i + 1}/{len(tree_lines)}")

    # 4) 建 tree（base_tree=远端，叠加本地）
    #    422 偶发（GitHub 对刚上传 blob 的可见性延迟，同一 blob 重试即成功）→ 做重试；
    #    中间一次先把全部 blob 重传一遍，确保对象库已同步，再重试建树。
    tree = None
    for attempt in range(1, 4):
        st, res = req(token, "POST", "/git/trees", {"base_tree": base_tree, "tree": entries})
        if st in (200, 201):
            tree = res
            break
        msg = res.get("message", res) if isinstance(res, dict) else res
        log(f"⚠️ 建 tree 第 {attempt}/3 次失败: {st} {msg}")
        if attempt == 2:
            log("   重传全部 blob 后重试…")
            for path, osha, data in uploaded:
                req(token, "POST", "/git/blobs",
                    {"content": base64.b64encode(data).decode(), "encoding": "base64"})
        time.sleep(2)
    if tree is None:
        log("❌ 建 tree 失败（重试 3 次仍失败）")
        sys.exit(1)
    log(f"tree = {tree['sha'][:10]}")

    if args.dry_run:
        log("🟡 dry-run：未写入远端。tree SHA =", tree["sha"])
        return

    # 5) 建 commit（parent=远端，快进）
    msg = args.message or git(["log", "-1", "--pretty=%B"]).strip()
    st, commit = req(token, "POST", "/git/commits",
                     {"message": msg, "tree": tree["sha"], "parents": [parent]})
    if st not in (200, 201):
        log("❌ 建 commit 失败:", st, commit)
        sys.exit(1)
    log(f"commit = {commit['sha'][:10]}")

    # 6) 更新远端 main
    st, upd = req(token, "PATCH", "/git/refs/heads/main", {"sha": commit["sha"], "force": False})
    if st != 200:
        log("❌ 更新 main 失败:", st, upd)
        sys.exit(1)
    log("✅ 远端 main 已更新")

    # 7) 可选打 tag
    do_tag = args.tag or (not args.no_tag and not args.dry_run and args.message is not None)
    if do_tag:
        ver = json.load(open("package.json", encoding="utf-8"))["version"]
        tag = "v" + ver
        st, _ = req(token, "POST", "/git/refs", {"ref": f"refs/tags/{tag}", "sha": commit["sha"]})
        log(f"tag {tag} = {st}")

    # 8) 版权安全闸：校验远端 mp3 = 0
    st, tchk = req(token, "GET", f"/git/trees/{tree['sha']}?recursive=1")
    if st == 200:
        mp3 = [e["path"] for e in tchk["tree"] if e["path"].lower().endswith(".mp3")]
        if mp3:
            log(f"🚨 警告：远端 tree 仍含 {len(mp3)} 个 mp3！未自动回滚，请人工处理：")
            for m in mp3[:10]:
                log("   ", m)
        else:
            log("🔒 远端 mp3 = 0（版权安全）")
    log("🎉 推送完成")


if __name__ == "__main__":
    main()
