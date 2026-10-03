// forward.mjs <listenPort> <targetHost> <targetPort> | <listenPort> <socketPath>
// A plain TCP forwarder. OpenHuman refuses to send a bearer to a non-loopback
// http endpoint, so its adapter reaches the metering proxy through 127.0.0.1.
// With a socket path it forwards to the proxy's unix socket instead (Harbor
// tasks, where the container's network belongs to the task). Bytes pass through
// untouched; the cost is a few KB of RAM and negligible CPU.
import net from "node:net";
const [listenPort, host, port] = process.argv.slice(2);
net
  .createServer((client) => {
    const upstream = port === undefined ? net.connect(host) : net.connect(Number(port), host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
  })
  .listen(Number(listenPort), "127.0.0.1");
