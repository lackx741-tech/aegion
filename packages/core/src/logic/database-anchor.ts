// @ts-nocheck
/**
 * Database Anchor — explicit pg connection parsing for Host Resolution.
 */
import { Pool, type PoolConfig } from 'pg'

export type DatabaseAnchorBinding = {
  readonly protocol: 'postgres://' | 'postgresql://'
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly database: string
  readonly search: string
  readonly connectionString: string
}

function stripDatabaseAnchorEnvelope(raw: string): string {
  let s = raw.trim()
  while (s.toUpperCase().startsWith('DATABASE_URL=')) {
    s = s.slice('DATABASE_URL='.length).trim()
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1)
  }
  return s
}

function safeDecodeDatabaseComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function stripPlaceholderBrackets(value: string): string {
  if (value.startsWith('[') && value.endsWith(']') && value.length > 2) {
    return value.slice(1, -1)
  }
  return value
}

function encodeDatabaseAuthComponent(value: string): string {
  return encodeURIComponent(stripPlaceholderBrackets(safeDecodeDatabaseComponent(value)))
}

function splitDatabaseAndSearch(pathAndSearch: string): { database: string; search: string } {
  const searchIdx = pathAndSearch.search(/[?#]/)
  if (searchIdx < 0) {
    return { database: pathAndSearch, search: '' }
  }
  return {
    database: pathAndSearch.slice(0, searchIdx),
    search: pathAndSearch.slice(searchIdx),
  }
}

function parseHostAndPort(authority: string): { host: string; port: number | null } | null {
  if (!authority) return null
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end < 0) return null
    const host = authority.slice(1, end)
    const rest = authority.slice(end + 1)
    const port = rest.startsWith(':') && /^\d+$/.test(rest.slice(1)) ? Number(rest.slice(1)) : null
    return { host, port }
  }

  const portSep = authority.lastIndexOf(':')
  if (portSep > 0 && /^\d+$/.test(authority.slice(portSep + 1))) {
    return {
      host: authority.slice(0, portSep),
      port: Number(authority.slice(portSep + 1)),
    }
  }
  return { host: authority, port: null }
}

export function parseDatabaseAnchorBinding(
  raw: string,
  options: { port?: number } = {},
): DatabaseAnchorBinding | null {
  const s = stripDatabaseAnchorEnvelope(raw)
  const protocolMatch = /^(postgres(?:ql)?:\/\/)/i.exec(s)
  if (!protocolMatch) return null

  const protocol = protocolMatch[1]!.toLowerCase() as 'postgres://' | 'postgresql://'
  const rest = s.slice(protocolMatch[1]!.length)
  const atIdx = rest.lastIndexOf('@')
  if (atIdx < 0) return null

  const auth = rest.slice(0, atIdx)
  const hostPathAndSearch = rest.slice(atIdx + 1)
  const passwordSep = auth.indexOf(':')
  if (passwordSep < 0) return null

  const pathSep = hostPathAndSearch.indexOf('/')
  const authority = pathSep >= 0 ? hostPathAndSearch.slice(0, pathSep) : hostPathAndSearch
  const pathAndSearch = pathSep >= 0 ? hostPathAndSearch.slice(pathSep + 1) : ''
  const hostPort = parseHostAndPort(authority)
  if (!hostPort?.host) return null

  const { database, search } = splitDatabaseAndSearch(pathAndSearch)
  const user = stripPlaceholderBrackets(safeDecodeDatabaseComponent(auth.slice(0, passwordSep)))
  const password = stripPlaceholderBrackets(safeDecodeDatabaseComponent(auth.slice(passwordSep + 1)))
  const port = options.port ?? hostPort.port ?? 5432
  const encodedUser = encodeDatabaseAuthComponent(user)
  const encodedPassword = encodeDatabaseAuthComponent(password)
  const encodedDatabase = encodeURIComponent(safeDecodeDatabaseComponent(database || 'postgres'))

  return {
    protocol,
    host: hostPort.host,
    port,
    user,
    password,
    database: safeDecodeDatabaseComponent(database || 'postgres'),
    search,
    connectionString: `${protocol}${encodedUser}:${encodedPassword}@${hostPort.host}:${port}/${encodedDatabase}${search}`,
  }
}

/**
 * Host Resolution path for DATABASE_URL.
 * Normalizes auth components so special characters never bleed into host parsing.
 */
export function resolveDatabaseAnchorConnectionString(raw: string, options: { port?: number } = {}): string {
  const binding = parseDatabaseAnchorBinding(raw, options)
  return binding?.connectionString ?? stripDatabaseAnchorEnvelope(raw)
}

/** Telemetry helper only; does not affect actual `pg` parsing. */
export function resolveDatabaseAnchorHost(raw: string): string {
  const binding = parseDatabaseAnchorBinding(raw)
  return binding?.host ?? '(unresolved)'
}

/** Telemetry helper only; returns the active target port. */
export function resolveDatabaseAnchorPort(raw: string): number | null {
  return parseDatabaseAnchorBinding(raw)?.port ?? null
}

/** Telemetry helper only; never returns password material. */
export function resolveDatabaseAnchorUser(raw: string): string {
  const binding = parseDatabaseAnchorBinding(raw)
  return binding?.user ?? '(unresolved)'
}

function isLocalDatabaseHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
}

function postgresSslOption(host: string): PoolConfig['ssl'] | false {
  if (isLocalDatabaseHost(host)) return false
  return {
    rejectUnauthorized: false,
    servername: host,
    checkServerIdentity: (_host: string, _cert: object) => undefined,
  }
}

export function createDatabaseAnchorPool(
  rawConnectionString: string,
  overrides: Omit<PoolConfig, 'connectionString'> = {},
  options: { port?: number } = {},
): Pool {
  const binding = parseDatabaseAnchorBinding(rawConnectionString, options)
  if (binding) {
    return new Pool({
      host: binding.host,
      port: binding.port,
      user: binding.user,
      password: binding.password,
      database: binding.database,
      ssl: postgresSslOption(binding.host),
      connectionTimeoutMillis: 10_000,
      ...overrides,
    })
  }

  return new Pool({
    connectionString: resolveDatabaseAnchorConnectionString(rawConnectionString),
    ssl: postgresSslOption(resolveDatabaseAnchorHost(rawConnectionString)),
    ...overrides,
  })
}
