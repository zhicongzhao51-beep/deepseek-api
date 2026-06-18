'use strict';

const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  transport: config.nodeEnv === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true } },
});

module.exports = logger;
