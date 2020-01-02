'use strict';

const apiResponse = require('./api-response.json');
const k8s = require('@kubernetes/client-node');
const jobs = [];

class BatchApiMock {
    createNamespacedJob(namespace, job) {
        if (this.expectFailure) {
            return Promise.reject('failed');
        } else {
            jobs.push({...job, status: 'active' });
            return Promise.resolve({ response: { status_code: 200 }});
        }
    }
    listNamespacedJob(namespace, pretty, allowWatchBookmarks, _continue, fieldSelector, labelSelector) {
        if (this.expectFailure) {
            return Promise.reject('failed');
        }

        const selectorLabels = Object.keys(labelSelector);
        const resultSet = jobs
            .filter(job => job.status === fieldSelector.status)
            .filter(job => selectorLabels.filter(label => labelSelector[label] != job.metadata.labels[label].length).length != selectorLabels.length);

        return Promise.resolve({ body: { items: jobs } });
    }
}

class CoreApiMock {
    createNamespacedSecret(namespace, secret) {
        if (this.expectFailure) {
            return Promise.reject('failed');
        } else {
            return Promise.resolve({ response: { status_code: 200 }});
        }
    }
    readNamespacedConfigMap(namespace, name) {
        if (this.expectFailure) {
            return Promise.reject('failed');
        } else {
            if (!apiResponse.configMap[namespace] || !apiResponse.configMap[namespace][name]) {
                console.error(`Could not find api response for ${namespace}/${name}`);
                return Promise.reject('404');
            } else {
                return Promise.resolve(apiResponse.configMap[namespace][name]);
            }
        }
    }
}

class KubeConfigTestImpl {
    loadFromDefault() {
    }
    makeApiClient(api) {
        if (api == k8s.BatchV1Api) {
            return new BatchApiMock();
        } else {
            return new CoreApiMock();
        }
    }
}

/**
 * @type {KubeConfigTestImpl}
 */
module.exports = KubeConfigTestImpl;
