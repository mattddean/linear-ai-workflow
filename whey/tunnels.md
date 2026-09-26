# Junior isolate tunnels

Junior uses its ordinary `bun run dev` command. In a Whey isolate, the `dev:tunnel` Turbo task registers two
hostnames with a single shared local gateway:

- `https://api-RUN_ID.dev.mtdn.dev` forwards to that isolate's API port.
- `https://expo-RUN_ID.dev.mtdn.dev` forwards to that isolate's Expo/Metro port, including WebSockets.

The gateway listens only on `127.0.0.1:45800`. One named Cloudflare Tunnel connects it to the Internet.
Registration uses a private Unix socket, never a publicly routed HTTP endpoint. Only running, registered
isolates are routed; unknown hosts receive 404. Database and Drizzle Studio ports are not exposed.

## One-time Cloudflare setup

1. In the `mtdn.dev` zone, ensure an active edge certificate covers `*.dev.mtdn.dev`. Universal SSL for
   `mtdn.dev` does not cover this second-level wildcard. An Advanced Certificate with that wildcard is one
   option; it may require a paid Cloudflare add-on. Wait for certificate issuance before testing devices.
2. Create a **locally managed** tunnel from this Mac (the CLI is already installed):

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create junior-isolates
   cloudflared tunnel route dns junior-isolates '*.dev.mtdn.dev'
   ```

   The last command creates a proxied wildcard CNAME to `TUNNEL_UUID.cfargotunnel.com`. You can instead add
   that CNAME in Cloudflare DNS: name `*.dev`, target `TUNNEL_UUID.cfargotunnel.com`, proxy enabled.
   Use a dedicated tunnel for this gateway; leave `junior-api-dev` and its existing DNS record unchanged.

3. Copy [cloudflared.example.yml](cloudflared.example.yml) to `~/.cloudflared/junior-isolates.yml`.
   Replace both `REPLACE_WITH_TUNNEL_UUID` occurrences with the UUID printed by `create`. Keep the generated
   credentials JSON in `~/.cloudflared`; do not copy it into an isolate or commit it.
4. Validate the local configuration:

   ```sh
   cloudflared tunnel --config ~/.cloudflared/junior-isolates.yml ingress validate
   cloudflared tunnel --config ~/.cloudflared/junior-isolates.yml ingress rule https://api-check.dev.mtdn.dev
   ```

The wildcard rule must forward to **HTTP** `127.0.0.1:45800`, preserve the Host header, and precede the 404
catch-all. Do not set an origin Host override. Cloudflare terminates public HTTPS. No per-isolate DNS records,
tunnel creation, or Cloudflare API credentials are needed after this setup.

These URLs publish the development API and Metro server. Existing API authentication remains in place;
Metro is a development server. A Cloudflare Access browser-login challenge would prevent a native client
from connecting unless that client is separately configured to satisfy Access.

## Running and switching isolates

Use Whey `start`/`open` with Junior's source `.whey.jsonc`. Whey writes `EXPO_PUBLIC_API_URL` and
`EXPO_PACKAGER_PROXY_URL` into the isolate environment before launching `bun run dev`. The latter tells
Expo to advertise its public URL in the development-client QR code. Open that isolate's Expo link in the
existing Junior development build on the phone. The tunnel command prints both URLs in Turbo's tunnel pane.

The first `dev:tunnel` task starts the shared gateway and connector in the background. Further isolates
attach to that gateway. A duplicate task for the same isolate fails instead of replacing its live routes.
Stopping a task (including an abrupt process exit) closes its private connection, removes its routes, and
closes its in-flight connections. Other isolates continue working. After the final registration closes,
the gateway waits ten seconds, then stops its connector and exits. The ordinary, non-isolate checkout
continues using the existing `junior-api-dev` command.

Whey stop/destroy closes the Ghostty processes and therefore their registrations. Headless `bun run dev`
sessions must be stopped in their own terminal. No tunnel or DNS record is deleted on shutdown.

Existing snapshots keep their own source revision: they need the updated Junior scripts, Turbo environment
forwarding, and authentication configuration before using the new source Whey configuration. Do not silently
copy files into a managed ticket snapshot and invalidate its QA evidence. New snapshots must be created from
a commit containing those changes. Merely reopening an existing Space does not restart its terminal commands.

## Diagnostics and verification

- Shared connector output goes to Junior's `.whey/tunnel.log`.
- Missing local Cloudflare configuration produces an actionable error in `dev:tunnel`.
- An occupied gateway port fails startup instead of taking over an unrelated process.
- A 404 means there is no registered isolate for that hostname; 502 means its local service is unavailable.
- If the connector exits, attached tunnel tasks fail visibly; restart the tunnel task after fixing its configuration.
- A healthy local registration is not proof of public DNS, edge certificate readiness, or device connectivity.
- To change the gateway domain, port, or Cloudflare config path, stop all attached tunnel tasks first, update
  Junior's `tunnel` settings and the matching Cloudflare configuration, then restart. Hostnames and generated
  app URLs derive from the same domain setting.

The automated tests use local fake origins and a fake connector. They verify concurrent isolates, separate
API/Expo routing, request forwarding, streaming, WebSockets, duplicate registration, gateway ownership, and
disconnect cleanup without contacting Cloudflare. Public HTTPS and physical-device verification require
the setup above and the user's existing development build.

References: [Cloudflare ingress](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/),
[wildcard DNS](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/),
[Universal SSL coverage](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/),
[Expo CLI proxy URL](https://docs.expo.dev/more/expo-cli/).
