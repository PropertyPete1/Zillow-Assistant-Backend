import winston from 'winston';

export const log = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ level, message, timestamp, ...meta }) =>
      JSON.stringify({ ts: timestamp, level, message, ...meta })
    )
  ),
  transports: [new winston.transports.Console()],
});


