import { Schema } from 'effect'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Validates local gateway settings and the private registration protocol shared by Whey clients.

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))
const Host = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/))
const IsolateId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,57}$/))

export const decodeTunnelSettings = Schema.decodeUnknownSync(
  Schema.Struct({
    domain: Host,
    port: Port,
    configFile: Schema.NonEmptyString,
    apiPortKey: Schema.NonEmptyString,
    expoPortKey: Schema.NonEmptyString,
  }),
)

export const decodeRegistration = Schema.decodeUnknownSync(
  Schema.Struct({
    isolate_id: IsolateId,
    api_port: Port,
    expo_port: Port,
    gateway_key: Schema.NonEmptyString,
  }),
)

export const decodeReply = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ status: Schema.Literal('ready'), api_url: Schema.String, expo_url: Schema.String }),
    Schema.Struct({ status: Schema.Literal('error'), message: Schema.String }),
  ]),
)

export function gatewayIdentity(settings) {
  const key = createHash('sha256').update(JSON.stringify(settings)).digest('hex')
  return { key, socketPath: path.join(tmpdir(), `whey-${process.getuid()}-${key.slice(0, 16)}.sock`) }
}

export function tunnelUrls(domain, isolateId) {
  return { api_url: `https://api-${isolateId}.${domain}`, expo_url: `https://expo-${isolateId}.${domain}` }
}
