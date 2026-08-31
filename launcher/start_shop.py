#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""商城启动器：启动 Node 服务并打开浏览器"""
import os
import sys
import time
import socket
import ctypes
import subprocess
import webbrowser

SHOP_DIR = r"C:\Users\华为mate14\WorkBuddy\2026-08-24-15-09-30\clearance-shop"
NODE_EXE = r"C:\Users\华为mate14\.workbuddy\binaries\node\versions\22.22.2\node.exe"
PORT = 4301


def is_port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def find_node_pid():
    """查找监听 4100 端口的 node 进程 PID（通过 netstat）"""
    try:
        result = subprocess.run(
            ['netstat', '-ano'],
            capture_output=True, text=True, encoding='gbk', errors='ignore',
            creationflags=0x08000000  # CREATE_NO_WINDOW，避免闪黑框
        )
        for line in result.stdout.splitlines():
            if f':{PORT}' in line and 'LISTENING' in line:
                parts = line.strip().split()
                return int(parts[-1])
    except Exception:
        pass
    return None


def start_service():
    if not os.path.exists(NODE_EXE):
        raise FileNotFoundError(f'找不到 node.exe: {NODE_EXE}')

    pid = find_node_pid()
    if pid:
        return

    # 把 Python 侧选定的端口传给 node，确保 server.js 实际监听一致端口
    env = os.environ.copy()
    env['PORT'] = str(PORT)

    # 只在失败时输出；成功时保持静默，避免闪屏
    # CREATE_NO_WINDOW = 0x08000000，避免显示黑框
    log_path = os.path.join(SHOP_DIR, 'server.log')
    log_file = open(log_path, 'a', encoding='utf-8')
    subprocess.Popen(
        [NODE_EXE, 'server.js'],
        cwd=SHOP_DIR,
        env=env,
        creationflags=0x08000000,
        stdout=log_file,
        stderr=log_file,
        stdin=subprocess.DEVNULL
    )

    # 等待服务启动
    for i in range(15):
        time.sleep(0.5)
        if is_port_open(PORT):
            return

    raise RuntimeError('服务启动失败，请检查端口是否被占用或 node 是否正常运行。')


def open_client():
    webbrowser.open('http://localhost:4301/')


def open_admin():
    webbrowser.open('http://localhost:4301/admin')


def show_error(msg):
    """弹出错误对话框（用于 pythonw.exe 无控制台场景）"""
    try:
        ctypes.windll.user32.MessageBoxW(0, msg, '不初限时狂欢商城', 0x10)
    except Exception:
        pass


def main():
    try:
        start_service()
        if len(sys.argv) > 1 and sys.argv[1] == '--admin':
            open_admin()
        else:
            open_client()
    except Exception as e:
        show_error(f'启动失败: {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()
