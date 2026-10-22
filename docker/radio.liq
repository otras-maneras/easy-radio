settings.log.stdout.set(true)
settings.log.file.set(false)
settings.server.telnet.set(true)
settings.server.telnet.bind_addr.set("0.0.0.0")
settings.server.telnet.port.set(1234)

# The API explicitly reloads after atomic playlist replacements.
music = playlist(id="library", mode="normal", reload_mode="never", "/data/playlist.m3u")

broadcast = output.icecast(
  id="broadcast",
  fallible=true,
  %mp3(bitrate=128, stereo=true),
  host="icecast",
  port=8000,
  password=getenv("ICECAST_PASSWORD"),
  mount="radio.mp3",
  name="Frecuencia",
  description="Tu musica, una frecuencia.",
  public=false,
  music
)

def start_broadcast(_) =
  music.reload(empty_queue=true)
  music.skip()
  broadcast.start()
  "OK"
end

def stop_broadcast(_) =
  broadcast.stop()
  "OK"
end

server.register(namespace="broadcast", "start", start_broadcast)
server.register(namespace="broadcast", "stop", stop_broadcast)
