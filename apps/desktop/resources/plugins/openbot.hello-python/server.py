# 示例插件 · 最小可抄模板（Python 版，v0.1.92——docs/plan-plugins.md §3）：
# 单文件 MCP server（stdio JSON-RPC），零依赖纯标准库。两个工具：
#   pyhello  { name?: string }   → 回问候语 + 运行时 Python 版本（拉模型演示）
#   pynotify { text: string }    → 发一条上行事件（openbot/event）再返回确认（推模型演示）
# 照抄改：复制本目录 → 改 manifest 的 id/name/entry → 改这里的工具与事件 → 放进市场或本地目录。
# 两个 Windows 管道坑（实证记档）：
#   1) stdout 必须行缓冲——缺省全缓冲时对端收不到行级应答（node readline 按行等）
#   2) 管道编码缺省随 locale（中文 Windows 是 GBK）——中文 JSON 必炸，须显式 UTF-8
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

TOOLS = [
    {
        "name": "pyhello",
        "description": "回一声问候并报告运行时 Python 版本（Python 示例插件的演示工具）",
        "inputSchema": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "要问候的名字（可选）"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "pynotify",
        "description": "发送一条上行事件（推模型演示：事件经内核路由为用户通知/唤醒绑定 Agent）",
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "事件文本"}},
            "required": ["text"],
            "additionalProperties": False,
        },
    },
]


def send(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")


while True:
    line = sys.stdin.readline()
    if not line:
        break  # EOF：宿主关闭管道（禁用/回收）——安静退出
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    method = msg.get("method")
    msg_id = msg.get("id")
    params = msg.get("params") or {}

    if method == "initialize":
        send(
            {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "protocolVersion": params.get("protocolVersion", "2025-06-18"),
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "hello-python", "version": "0.1.0"},
                },
            }
        )
    elif method == "notifications/initialized":
        continue
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}})
    elif method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name == "pyhello":
            text = "你好，{}！——来自示例插件 hello-python（Python {}）".format(
                args.get("name") or "OpenBot", sys.version.split()[0]
            )
            send({"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": text}]}})
        elif name == "pynotify":
            # 推模型：上行事件（notification openbot/event）→ 内核 v1.plugin.event → 路由
            text = str(args.get("text", ""))
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "openbot/event",
                    "params": {"type": "hello-python.fired", "payload": {"text": text}},
                }
            )
            send({"jsonrpc": "2.0", "id": msg_id, "result": {"content": [{"type": "text", "text": "事件已发送：" + text}]}})
        else:
            send({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32602, "message": "未知工具：" + str(name)}})
