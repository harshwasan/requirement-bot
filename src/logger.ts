import pino from 'pino'
import { config } from './config'

const transport = config.logPretty
  ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
  : undefined

const rootLogger = pino({
  level: config.logLevel,
  ...(transport ? { transport } : {}),
})

export function createLogger(name: string) {
  return rootLogger.child({ module: name })
}

export default rootLogger
