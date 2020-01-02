'use strict';

const { EventEmitter } = require('events');
const JobConfig = require('./job-config');
const logger = require('./logger');
const yaml = require('yaml');

class MessageController {
    /**
     * @param {KubernetesClient} k8sClient 
     * @param {AmqpClient} amqpClient 
     * @param {string} configMapName 
     * @param {boolean} reloadEnabled 
     * @param {string} podNamespace 
     * @param {string} defaultRegistry 
     */
    constructor(k8sClient, amqpClient, configMapName, reloadEnabled, podNamespace, defaultRegistry) {
        this.k8s = k8sClient;
        this.amqp = amqpClient;
        this.podNamespace = podNamespace;
        this.reloadEnabled = reloadEnabled;
        this.defaultRegistry = defaultRegistry;
        this.configMapName = configMapName;
        this.configReload = new EventEmitter();
        this.lastSeenActive = {};
        this.configReloader = null;

        /** @type {Object.<string, JobConfig>} */
        this.config = {};
    }

    start() {
        this.configReload.on('reload', configs => this.amqp.updateListeners(
            Object.keys(configs).map(key => ({ 
                name: configs[key].alias, 
                interval: configs[key].interval 
            })),
            this.onMessage.bind(this),
            this.getProcessingState.bind(this)));

        if (this.reloadEnabled) {
            this.configReloader = setInterval(() => this.reloadConfig(), 60000);
        }

        this.reloadConfig();
    }

    stop() {
        if (this.configReloader) {
            clearInterval(this.configReloader);
            this.configReloader = null;
        }

        this.setConfig({});
    }

    /**
     * @param {string} queue name of the queue the message is coming from
     * @param message the amqp message object
     */
    onMessage(queue, message) {
        if (logger.isDebugEnabled()) {
            logger.debug('Received new message', { queue, inflight: message });
        }

        return this.k8s.createMessageJob(this.config[queue], message.content.toString('utf8'));
    }

    /**
     * @param {string} queue name of queue to check
     * @return {Promise<{busy: boolean, state: string, count: number}>} may return 'Unknown' if state cannot be discovered
     */
    async getProcessingState(queue) {
        const config = this.config[queue];
        if (!config) {
            return { busy: true, state: 'notfound', count: -1 };
        } else if (config.parallelism === 'unlimited') {
            return { busy: false, state: 'unlimited', count: 0 };
        }

        try {
            const active = await this.k8s.countActiveMessageJobs(config);
            this.lastSeenActive[queue] = { count: active, time: new Date() };

            return { 
                active, 
                state: 'fresh',
                busy: config.parallelism < active,
            };
        } catch (error) {
            logger.warn('Unknown processing state, using local fallback', { queue, error });

            const lastActive = this.lastSeenActive[queue];
            if (!lastActive) {
                this.lastSeenActive[queue] = { everSeen: false, count: 0 };
            }

            const lastActiveCount = (lastActive && lastActive.count) || 0;
            const fallback = {
                active: lastActiveCount,
                busy: config.parallelism < (lastActiveCount + 1),
                state: 'old',
            };

            // increase 'active count' for each call, 
            // never decrease as long as the result is old and not busy
            if (!fallback.busy) {
                this.lastSeenActive[queue].count++;
            }

            return fallback;
        }
    }

    reloadConfig() {
        logger.debug('Trying to reload configuration');

        this.k8s.getConfigMap(this.configMapName, this.podNamespace)
            .then(config => this.setConfig(config.body.data))
            .catch(err => {
                if (this.reloadEnabled) {
                    logger.warn('Error reloading configuration', err);
                } else {
                    logger.error('Could not load configuration and reload is not enabled', err);
                    process.exit(1);
                }
            });
    }

    /**
     * @param {Object.<string, Object>} config configuration for messages to process
     */
    setConfig(config) {
        const currentConfigKeys = Object.keys(this.config);
        const newKeys = Object.keys(config);
        const newConfig = {};

        newKeys
            .map(key => ({ alias: key, config: yaml.parse(config[key]) }))
            .map(data => new JobConfig(data.alias, data.config, this.k8s.scope, this.defaultRegistry))
            .forEach(config => newConfig[config.alias] = config);

        const hasChanged = newKeys.some(key => !newConfig[key].equals(this.config[key]));

        logger.debug(
            'Found %d configurations, currently provided: %d, contains changes: %s', 
            newKeys.length, 
            currentConfigKeys.length,
            hasChanged
        );

        if (hasChanged || (newKeys.length == 0 && currentConfigKeys.length > 0)) {
            this.config = newConfig;
            this.configReload.emit('reload', this.config);
            logger.info('Configuration reloaded', { configs: newKeys });
        } else {
            logger.info('No configurations changed');
        }
    }
}

/**
 * @type {MessageController}
 */
module.exports = MessageController;
