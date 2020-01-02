'use strict';

const crypto = require('crypto');
const Promise = require('bluebird');

class KubernetesClient {
    /**
     * @param {string} scope the namespace to create jobs in
     * @param delegate real client implementation to access k8s api
     */
    constructor(scope, delegate) {
        this.scope = scope;
        this.delegate = delegate;
        this.encodedIssuer = Buffer.from('goci/kubernetes-event-job').toString('base64');
    }

    /**
     * @param {boolean} isProduction
     * @return {Promise<KubernetesClient>}
     */
    init(isProduction) {
        const kc = new this.delegate.KubeConfig();
        if (isProduction) {
            kc.loadFromCluster();
        } else {
            kc.loadFromDefault();
        }

        this.batchApi = kc.makeApiClient(this.delegate.BatchV1Api);
        this.coreApi = kc.makeApiClient(this.delegate.CoreV1Api);

        return Promise.resolve(this);
    }
    
    /**
     * creates a job to process the message
     * 
     * @param {JobConfig} config configuration for deploying the job
     * @param {string} message the message content to dispatch
     * @return {Promise}
     */
    createMessageJob(config, message) {
        const jobManifest = config.createJobTemplate();

        return new Promise((resolve, reject) => this.createMessageSecret(config.namespace, config.jobName, jobManifest.metadata.name, message)
            .then(() => this.batchApi.createNamespacedJob(config.namespace, jobManifest).then(() => resolve({ 
                job: jobManifest.metadata.name, 
                alias: config.alias, 
                jobName: config.jobName 
            })).catch(reject))
            .catch(reject))
    }

    /**
     * Returns active message jobs and limits the results to {@code config.parallelism + 1}
     * 
     * @param {JobConfig} config to count jobs for
     * @return {Promise<number>}
     */
    countActiveMessageJobs(config) {
        const activeJobsFilter = 'status.active=1';
        return this.batchApi.listNamespacedJob(config.namespace, null, null, null, activeJobsFilter, config.labels, config.parallelism + 1)
            .then(result => result.body.items.length);
    }

    /**
     * creates a secret to use for a Pod to process the message
     * 
     * @param {string} namespace namespace to create the secret in
     * @param {string} job alias or name of the related configuration
     * @param {string} name name of the secret
     * @param {string} message content of the message
     * @return {Promise}
     */
    createMessageSecret(namespace, job, name, message) {
        return this.coreApi.createNamespacedSecret(namespace, {
            metadata: { name, namespace },
            data: {
                ISSUER: this.encodedIssuer,
                TARGET: Buffer.from(name).toString('base64'),
                MESSAGE: Buffer.from(message).toString('base64'),
                CHECKSUM: crypto.createHash('sha1').update(`${namespace}:${job}:${message}`, 'utf8').digest('base64'),
            }
        });
    }

    /**
     * @param {string} namespace
     * @param {string} name
     * @return {Promise} api response
     */
    getConfigMap(namespace, name) {
        return this.coreApi.readNamespacedConfigMap(namespace, name);
    }
}

/**
 * @type {KubernetesClient}
 */
module.exports = KubernetesClient;
