#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""带 Range 支持的静态服务器。

为什么需要它：python -m http.server 不支持 Range 请求，
视频无法 seek（拖进度条/跳转到第 738 秒都会失败或卡死）。
这里补上 206 Partial Content，并改用多线程，避免大文件阻塞页面资源。

用法: python tools/serve.py [端口] [目录]
"""
import os
import re
import sys
import mimetypes
import http.server
import socketserver

# 这几个类型 Python 的 mimetypes 不一定认识，
# 认错了浏览器会拒绝加载：wasm 必须 application/wasm，mjs 必须 JS。
mimetypes.add_type('application/wasm', '.wasm')
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('application/octet-stream', '.task')
mimetypes.add_type('video/webm', '.webm')
mimetypes.add_type('video/mp4', '.mp4')

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8931
ROOT = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else os.getcwd()
# ROOT 必须绝对化：os.chdir(ROOT) 之后 handler 的 directory 若还是相对路径，
# 会被解析成「cwd 下的同名子目录」（prototype/prototype/），整个服务 404


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().do_GET()
        if not os.path.isfile(path):
            return super().do_GET()
        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, 'not found')
            return

        size = os.fstat(f.fileno()).st_size
        ctype = self.guess_type(path)
        start, end, code = 0, size - 1, 200

        rng = self.headers.get('Range')
        if rng:
            m = re.search(r'bytes=(\d*)-(\d*)', rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                elif m.group(2):            # bytes=-500 形式
                    start = max(0, size - int(m.group(2)))
                    end = size - 1
                end = min(end, size - 1)
                if start > end:
                    f.close()
                    self.send_response(416)
                    self.send_header('Content-Range', 'bytes */%d' % size)
                    self.end_headers()
                    return
                code = 206

        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if code == 206:
            self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.end_headers()

        f.seek(start)
        left = end - start + 1
        try:
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass   # 浏览器取消加载（拖动进度条/中断 wasm 下载）是常态，不算错误
        finally:
            f.close()

    def log_message(self, fmt, *args):
        pass   # 静音，避免刷屏


class Threaded(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == '__main__':
    os.chdir(ROOT)
    with Threaded(('127.0.0.1', PORT), RangeHandler) as httpd:
        print('serving %s at http://127.0.0.1:%d  (Range enabled)' % (ROOT, PORT), flush=True)
        httpd.serve_forever()
