'use strict';

const AMQP_HOSTNAME = process.env.AMQP_HOST || 'localhost';
const AMQP_PORT = process.env.AMQP_PORT || 5672;
const AMQP_USERNAME = process.env.AMQP_USERNAME;
const AMQP_PASSWORD = process.env.AMQP_PASSWORD;
const DOCKER_REGISTRY = process.env.DOCKER_REGISTRY;
const POD_NAMESPACE  = process.env.POD_NAMESPACE || 'default';
const KUBERNETES_JOB_SCOPE = process.env.KUBERNETES_JOB_SCOPE || 'default';
const CONFIG_MAP_NAME = process.env.CONFIG_MAP_NAME || 'event-job-provisioner-configs';
const RELOAD_ENABLED = ['false', '0', 'no', 'off'].indexOf(process.env.RELOAD_ENABLED) < 0;
const isProduction = process.env.NODE_ENV === 'production';

const k8sDelegate = require('@kubernetes/client-node');
const MessageController = require('./controller');
const KubernetesClient = require('./client/k8s');
const AmqpClient = require('./client/amqp');
const logger = require('./logger');

process
    .on('unhandledRejection', (reason, p) => {
        logger.error('Unhandled Rejection at Promise: ' + reason, p);
        process.exit(1);
    })
    .on('uncaughtException', err => {
        logger.error('Uncaught Exception thrown', err);
        process.exit(1);
    });

const k8s = new KubernetesClient(KUBERNETES_JOB_SCOPE, k8sDelegate);
const amqp = new AmqpClient(AMQP_HOSTNAME, AMQP_PORT, AMQP_USERNAME, AMQP_PASSWORD, 15, false);

Promise.all([k8s.init(isProduction), amqp.init()])
    .then(() => new MessageController(
        k8s, 
        amqp, 
        CONFIG_MAP_NAME, 
        RELOAD_ENABLED, 
        POD_NAMESPACE, 
        DOCKER_REGISTRY
    ).start())
    .catch(errors => {
        logger.error('Error while trying to initialize kubernetes and amqp client', errors);
        process.exit(1);
    });
