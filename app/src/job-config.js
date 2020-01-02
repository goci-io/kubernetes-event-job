'use strict';

const uuid = require('uuidv4').default;

const defaultResources = {
    requests: {
        cpu: '10m',
        memory: '56Mi',
    },
    limits: {
        cpu: '25m',
        memory: '96Mi',
    },
};

const defaultLabels = {
    'app.kubernetes.io/component': 'job',
    'app.kubernetes.io/managed-by': 'goci-kubernetes-event-job',
    'jobgroup': 'kubernetes-event-jobs',
};

const sameDataset = (a, b) => {
    return !Object.keys(a)
        .filter(k => b[k] !== a[k])
        .length;
}

class JobConfig {
    /**
     * @param {string} queue alias for the processor job
     * @param data
     * @param {string} defaultScope
     * @param {string} defaultRegistry
     */
    constructor(queue, data, defaultScope, defaultRegistry) {
        this.alias = queue;
        this.jobName = data.jobName;
        this.timeout = data.timeout || 3600;
        this.parallelism = data.parallelism || 10;
        this.environment = data.environment || [];
        this.interval = (data.interval || 60) * 1000;
        this.serviceAccount = data.serviceAccount;
        this.namespace = data.namespace || defaultScope;
        this.image = this.buildImageName(data, defaultRegistry);
        this.resources = {...defaultResources, ...data.resources};
        this.labels = Object.assign(data.labels || {}, defaultLabels, {
            'app.kubernetes.io/name': queue + '-processor',
            'app.kubernetes.io/version': data.imageVersion || 'latest',
            'app.kubernetes.io/part-of': this.namespace,
            'jobitem': this.jobName,
        });
    }

    createJobTemplate() {
        const name = `${this.jobName}-${uuid()}`
        const metadata = { 
            name, 
            namespace: this.namespace, 
            labels: this.labels 
        };

        const template = {
            metadata,
            spec: {
                parallelism: 1,
                backoffLimit: 5,
                ttlSecondsAfterFinished: 21600,
                activeDeadlineSeconds: this.timeout,
                template: {
                    metadata,
                    spec: {
                        restartPolicy: 'OnFailure',
                        containers: [
                            {
                                name: 'processor',
                                image: this.image,
                                env: this.environment,
                                envFrom: [{ secretRef: { name } }],
                                resources: this.resources,
                            },
                        ],
                    },
                },
            },
        };

        if (this.serviceAccount) {
            template.spec.template.spec.serviceAccount = this.serviceAccount;
        }

        return template;
    }

    /**
     * @param {JobConfig} other
     * @return {boolean}
     */
    equals(other) {
        return other && this.alias == other.alias
            && this.jobName == other.jobName
            && this.timeout == other.timeout
            && this.interval == other.interval
            && this.namespace == other.namespace
            && this.image == other.image
            && this.serviceAccount == other.serviceAccount
            && sameDataset(this.labels, other.labels)
            && sameDataset(this.resources.limits, other.resources.limits)
            && sameDataset(this.resources.requests, other.resources.requests)
            && !this.environment.filter(e => !other.environment.some(e2 => e2.name == e.name && e2.value == e.value)).length;
    }

    /**
     * @param config to build the image name (registry, image and imageVersion)
     * @param {string} defaultRegistry
     * @return {string}
     */
    buildImageName(config, defaultRegistry) {
        const imageVersion = config.imageVersion || 'latest';
        const registry = config.registry || defaultRegistry;

        if (registry) {
            return `${registry}/${config.image}:${imageVersion}`;
        } else {
            return `${config.image}:${imageVersion}`
        }
    }
}

/**
 * @type {JobConfig}
 */
module.exports = JobConfig;
