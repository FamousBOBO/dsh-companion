#!/usr/bin/env python3
"""在 SnowLuma 容器的 Xvfb 上点一下（镜像里没有 xdotool / xte）。

为什么需要它：QQ 的「自动登录」勾选框只在登录页上，容器无头运行、只能靠
X11 注入点击。libXtst 是 Xvfb/x11vnc 的依赖，镜像里现成有，用 ctypes 直接调。

用法（在容器内）：
    docker cp deploy/snowluma/xclick.py snowluma:/tmp/xclick.py
    docker exec snowluma python3 -I /tmp/xclick.py :1 935 670

坐标取自 1920x1080 的 Xvfb：扫码页「自动登录」勾选框约在 (935, 670)，
「刷新」按钮约在 (958, 578)。分辨率变了要重新量。
"""
import ctypes
import sys
import time

display_name = (sys.argv[1] if len(sys.argv) > 1 else ":1").encode()
x, y = int(sys.argv[2]), int(sys.argv[3])

x11 = ctypes.CDLL("libX11.so.6")
xtst = ctypes.CDLL("libXtst.so.6")

x11.XOpenDisplay.restype = ctypes.c_void_p
dpy = x11.XOpenDisplay(display_name)
if not dpy:
    raise SystemExit(f"cannot open display {display_name!r}")

x11.XDefaultScreen.restype = ctypes.c_int
screen = x11.XDefaultScreen(ctypes.c_void_p(dpy))

# 先移动再按下/抬起：某些 Electron 控件只认完整的 motion + button 序列。
xtst.XTestFakeMotionEvent(ctypes.c_void_p(dpy), screen, x, y, 0)
x11.XFlush(ctypes.c_void_p(dpy))
time.sleep(0.15)
xtst.XTestFakeButtonEvent(ctypes.c_void_p(dpy), 1, True, 0)
x11.XFlush(ctypes.c_void_p(dpy))
time.sleep(0.08)
xtst.XTestFakeButtonEvent(ctypes.c_void_p(dpy), 1, False, 0)
x11.XFlush(ctypes.c_void_p(dpy))
time.sleep(0.15)
x11.XCloseDisplay(ctypes.c_void_p(dpy))
print(f"clicked ({x},{y}) on {display_name.decode()}")
