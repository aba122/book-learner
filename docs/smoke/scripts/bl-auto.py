#!/usr/bin/env python3
"""book-learner 调试自动化桥驱动(在 Mac 上运行)。

用法: bl-auto.py <sock> <子命令> [参数...]
  js <代码>            在 WebView 执行(函数体,可 return/await),打印 JSON 结果
  text                 打印 document.body.innerText
  route                打印当前路由
  go <path>            BrowserRouter 导航(pushState + popstate)
  click <按钮文字>     点击 innerText 完全等于/包含该文字的 button/[role=button]/a(优先精确)
  clickall <文字>      同上但返回匹配数量并点击第一个
  type <selector> <文本>   给 input/textarea 设值(React 兼容)
  file <selector> <路径>   把本地文件喂给 <input type=file>
  wait <文字> [秒]     等待页面文本出现(默认 60s)
  waitgone <文字> [秒] 等待页面文本消失
  tray                 最近一次托盘标题
  quit                 触发 app.exit(0)(= Cmd+Q 路径)
  ls <key>             读 localStorage[key];  set <key> <value> 写 localStorage
"""
import base64
import json
import os
import socket
import sys


def call(sock_path, request, timeout=120):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(sock_path)
    s.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
    buf = b""
    while not buf.endswith(b"\n"):
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    s.close()
    return json.loads(buf.decode("utf-8"))


def js(sock_path, code, timeout_ms=60000):
    resp = call(sock_path, {"js": code, "timeout_ms": timeout_ms}, timeout=timeout_ms / 1000 + 10)
    if "error" in resp:
        print(json.dumps(resp, ensure_ascii=False))
        sys.exit(2)
    result = resp.get("result")
    if isinstance(result, dict) and "__error" in result:
        print("JS ERROR: " + result["__error"])
        sys.exit(3)
    return result


CLICK_JS = r"""
const label = %s; const exact = %s;
const els = Array.from(document.querySelectorAll('button, [role="button"], a, label'));
const norm = s => (s || '').replace(/\s+/g, ' ').trim();
let hit = els.find(e => norm(e.innerText) === label && !e.disabled);
if (!hit && !exact) hit = els.find(e => norm(e.innerText).includes(label) && !e.disabled);
if (!hit) return { clicked: false, candidates: els.map(e => norm(e.innerText)).filter(Boolean).slice(0, 60) };
hit.scrollIntoView({ block: 'center' });
hit.click();
return { clicked: true, text: norm(hit.innerText), disabled: !!hit.disabled };
"""

TYPE_JS = r"""
const el = document.querySelector(%s); if (!el) return { ok: false, reason: 'no element' };
const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, %s);
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return { ok: true, value: el.value };
"""

FILE_JS = r"""
const el = document.querySelector(%s); if (!el) return { ok: false, reason: 'no input' };
const bytes = Uint8Array.from(atob(%s), c => c.charCodeAt(0));
const f = new File([bytes], %s, { type: 'application/epub+zip' });
const dt = new DataTransfer(); dt.items.add(f); el.files = dt.files;
el.dispatchEvent(new Event('change', { bubbles: true }));
return { ok: true, files: el.files.length, size: f.size };
"""

WAIT_JS = r"""
const needle = %s; const gone = %s; const deadline = Date.now() + %d;
while (Date.now() < deadline) {
  const has = (document.body.innerText || '').includes(needle);
  if (has !== gone) return { ok: true, waited_ms: %d - (deadline - Date.now()) };
  await new Promise(r => setTimeout(r, 300));
}
return { ok: false, text: (document.body.innerText || '').slice(0, 4000) };
"""


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    sock, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3:]
    q = lambda s: json.dumps(s, ensure_ascii=False)
    if cmd == "js":
        out = js(sock, args[0])
    elif cmd == "text":
        out = js(sock, "return document.body.innerText")
        print(out)
        return
    elif cmd == "route":
        out = js(sock, "return location.pathname + location.search + location.hash")
    elif cmd == "go":
        out = js(sock, "history.pushState({}, '', %s); dispatchEvent(new PopStateEvent('popstate')); await new Promise(r => setTimeout(r, 400)); return location.pathname" % q(args[0]))
    elif cmd in ("click", "clickall"):
        out = js(sock, CLICK_JS % (q(args[0]), "true" if cmd == "click" and len(args) > 1 and args[1] == "exact" else "false"))
    elif cmd == "type":
        out = js(sock, TYPE_JS % (q(args[0]), q(args[1])))
    elif cmd == "file":
        with open(args[1], "rb") as fh:
            b64 = base64.b64encode(fh.read()).decode("ascii")
        out = js(sock, FILE_JS % (q(args[0]), q(b64), q(os.path.basename(args[1]))))
    elif cmd in ("wait", "waitgone"):
        secs = int(args[1]) if len(args) > 1 else 60
        ms = secs * 1000
        out = js(sock, WAIT_JS % (q(args[0]), "true" if cmd == "waitgone" else "false", ms, ms), timeout_ms=ms + 5000)
        if not out.get("ok"):
            print(json.dumps(out, ensure_ascii=False))
            sys.exit(4)
    elif cmd == "tray":
        out = call(sock, {"tray_title": True})
    elif cmd == "quit":
        out = call(sock, {"quit": True})
    elif cmd == "ls":
        out = js(sock, "return localStorage.getItem(%s)" % q(args[0]))
    elif cmd == "set":
        out = js(sock, "localStorage.setItem(%s, %s); return localStorage.getItem(%s)" % (q(args[0]), q(args[1]), q(args[0])))
    else:
        print("unknown command", cmd)
        sys.exit(1)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
