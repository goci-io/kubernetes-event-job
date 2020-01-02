'use strict';

const { createLogger, format, transports } = require('winston');

module.exports = createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: {
        app: 'goci-kubernetes-event-jobs',
    },
    format: format.combine(
        format.timestamp(),
        format.splat(),
        format.json(),
    ),
    transports: [
        new transports.Console(),
    ],
});  
