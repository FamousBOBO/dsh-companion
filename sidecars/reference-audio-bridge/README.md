# GPT-SoVITS 参考音频桥接

GPT-SoVITS 原生接口读取服务端音频路径。使用网页的「选择文件」时，可把本目录的桥接服务放到 **GPT-SoVITS 所在的服务器**，上传的路径才对语音服务可见。

需要 Python 3，无额外依赖。启动 GPT-SoVITS 后，在同一台服务器运行：

```sh
python server.py --port 9881 --upstream http://127.0.0.1:9880 --directory ./reference-audio
```

在媒体页将 GPT-SoVITS 服务地址设为桥接服务的地址。桥接接收 `/reference-audio` 音频并将 `/tts` 转发到固定上游。上传不会生成语音。WAV、MP3、OGG、FLAC 文件限制 16 MB；音频保存在指定目录，需要自行定期清理。

跨机器使用时通过 HTTPS 反向代理或安全隧道提供服务。监听非本机地址时必须设置环境变量 `REFERENCE_AUDIO_BRIDGE_TOKEN`，媒体页的 API Key 填入同一个值。桥接不会自动安装、启动或开放端口。

Breeze TTS 2 无需此桥接：参考音频在合成时作为文件发送到配置的远端服务。GPT-SoVITS 的输出保持 WAV；输出格式与参考音频格式是两回事。
