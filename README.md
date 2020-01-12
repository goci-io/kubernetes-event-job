# kubernetes-event-jobs

**Maintained by [@goci-io/prp-apps](https://github.com/orgs/goci-io/teams/prp-apps)**

_This project is in alpha stage._

This application can consume messages from an AMQP queue and deploy kubernetes jobs for each message to process. 
Please note that this setup may **not** suit your use case. In the context of [goci.io](https://goci.io) we use this application for example 
to create a new terraform setup once a new customer signed up and provision required resources (eg: repository, namespace etc.) and to support a microservice architecture based on decoupled message services.

This application uses a polling mechanism to get messages from a queue to avoid overloading kubernetes with jobs.
The max count of jobs running in parallel can be specified for each job/queue and can also be set to `unlimited` (not suggested). 

[Latest Tags](https://hub.docker.com/r/gocidocker/k8s-event-jobs/tags)

#### When this setup fits
- Longer processing times  
- Periodically receive messages    
- Completely decoupled job processing  
- You have backups and restore strategies for kubernetes backend  
- Utilize job scheduling and detailed look into any task (kubernetes job)  

#### When this setup does not fit
- Short processing times are important  
- Integrate with an existing application  
- Busy queues (eg: thousands of messages per minute)  

### Configuration

The following environment variables can be set to configure the app behaviour:

| Name | Description | Default |
|----------------|-------------------------------------------------|--------------------|
| AMQP_HOST | Host to AMQP broker | localhost |
| AMQP_PORT | Port the AMQP broker is listening on | 5672 |
| AMQP_USERNAME | Username to authenticate with the broker |  |
| AMQP_PASSWORD | Password to use to authenticate |  |
| DOCKER_REGISTRY | Default docker registry to use to fetch job images from |  |
| POD_NAMESPACE | The namespace the application runs in (namespace of config) | default |
| KUBERNETES_JOB_SCOPE | The kubernetes namespace to deploy jobs into | default |
| CONFIG_MAP_NAME | Name of the config map to configure the jobs | event-job-provisioner-configs |
| RELOAD_ENABLED | Whether to reload job configurations (!= off, no, 0, false) | true |

### Format

Messages need to be in a speicfic format to support additional environment variables etc.
The messages must be JSON formatted with the following properties:
- content  
- environment  

Example message:

```json
{
    "content": "string|object|array",
    "environment": {
        "ADDITIONAL_ENV": "value deployed into the message secret"
    }
}
```

When recieving a message a new Job will be deployed sourcing a secret with the following content as environment variables:

```json
{
    "ISSUER": "goci/kubernetes-event-job",
    "TARGET": "Name of the job containing a random UUID",
    "MESSAGE": "content of the message as string using JSON.stringify",
    "CHECKSUM": "sha1 hash of `${namespace}:${job}:${content}`",
}
```

### Deployment

You can view the exmample deployment file [here](https://github.com/goci-io/k8s-event-jobs/tree/master/Deployment.yaml). 
This example assumes you have RabbitMQ installed on your cluster and use `rabbitmq.default.svc.cluster.local` with credentials `test:test` on port 5672.

You can also use the [helm chart](https://github.com/goci-io/k8s-event-jobs/tree/master/helm)

### Run locally

To run the app locally you can use `make start`. To connect to your broker you need to either use a valid accessible amqp host address or forward the port from your local minikube to localhost.

### Run tests

To execute the tests run `make test`.

### Release

To create a new release create a new Tag on github following this convention: `v<major>.<minor>.<patch>[-rc<num>]`.
All code merged to the matser will be available using the `latest` release.

### Todos

- Finish and release helm chart  
- Read messages in batches   
- Authentication flow  
- Stop processing messages when there are too many failed jobs  
- Allow to process a batch of messages using kubernetes job completions and parallelism settings(?)    
- Allow to deploy custom resources to configure jobs/queue  
- Collect configs from other namepsaces with RBAC enabled  
- Support VHosts
