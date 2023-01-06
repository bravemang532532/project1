import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';


import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { RemovalPolicy, CfnOutput } from 'aws-cdk-lib';

import * as ec2 from 'aws-cdk-lib/aws-ec2';

import * as ecr from 'aws-cdk-lib/aws-ecr';

import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';


import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Duration } from 'aws-cdk-lib';



import { DockerImageAsset, NetworkMode } from '@aws-cdk/aws-ecr-assets';

import {
  aws_ecr_assets as assets,
  Stack,
  App,
} from 'aws-cdk-lib';

import * as path from 'path';

import * as ecrdeploy from 'cdk-ecr-deployment';

import * as codecommit from 'aws-cdk-lib/aws-codecommit';

import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';




// import * as ecrDeploy from '../src/index';





export class CdkMsgAppBackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);


    const githubUserName = new cdk.CfnParameter(this, "githubUserName", {
      type: "String",
      description: "Github username for source code repository"
    })

    const githubRepository = new cdk.CfnParameter(this, "githubRespository", {
      type: "String",
      description: "Github source code repository",
      default: "project1"
    })

    const githubPersonalTokenSecretName = new cdk.CfnParameter(this, "githubPersonalTokenSecretName", {
      type: "String",
      description: "The name of the AWS Secrets Manager Secret which holds the GitHub Personal Access Token for this project.",
      default: "/bravemang532532/project1/github/personal_access_token"
    })


    const table = new dynamodb.Table(this, 'Messages', {
      partitionKey: {
        name: 'app_id',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'created_at',
        type: dynamodb.AttributeType.NUMBER
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY, // NOT recommended for production code
    });
    new CfnOutput(this, 'TableName', { value: table.tableName });








    const vpc = new ec2.Vpc(this, "workshop-vpc", {
      cidr: "10.1.0.0/16",
      natGateways: 1,

      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        { cidrMask: 24, subnetType: ec2.SubnetType.PUBLIC, name: "Public" },
        { cidrMask: 24, subnetType: ec2.SubnetType.PRIVATE_WITH_NAT, name: "Private" }
      ],
      maxAzs: 3 // Default is all AZs in region
    });



    const repository = new ecr.Repository(this, "workshop-api", {
      repositoryName: "workshop-api"
    });


    const cluster = new ecs.Cluster(this, "MyCluster", {
      vpc: vpc
    });


    const logging = new ecs.AwsLogDriver({
      streamPrefix: "ecs-logs"
    });

    const taskrole = new iam.Role(this, `ecs-taskrole-${this.stackName}`, {
      roleName: `ecs-taskrole-${this.stackName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });


    const image = new assets.DockerImageAsset(this, 'CDKDockerImage', {
      // directory: path.join(__dirname, 'msg-app-backend'),
      directory: path.join(__dirname, '..', '..', 'msg-app-backend'),
      networkMode: NetworkMode.HOST,
    });


    new ecrdeploy.ECRDeployment(this, 'DeployDockerImage', {
      src: new ecrdeploy.DockerImageName(image.imageUri),
      dest: new ecrdeploy.DockerImageName(`${repository.repositoryUri}:latest`),
    });



    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ]
    });



    const fargateTaskDefinition = new ecs.FargateTaskDefinition(this, 'ApiTaskDefinition', {
      memoryLimitMiB: 512,
      cpu: 256,
    });
    fargateTaskDefinition.addToExecutionRolePolicy(executionRolePolicy);
    fargateTaskDefinition.addToTaskRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: [table.tableArn],
      actions: ['dynamodb:*']
    }));


    const container = fargateTaskDefinition.addContainer("backend", {
      // Use an image from Amazon ECR
      image: ecs.ContainerImage.fromRegistry(repository.repositoryUri),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'workshop-api' }),
      environment: {
        'DYNAMODB_MESSAGES_TABLE': table.tableName,
        'APP_ID': 'my-app'
      }
      // ... other options here ...
    });

    container.addPortMappings({
      containerPort: 3000
    });


    const sg_service = new ec2.SecurityGroup(this, 'MySGService', { vpc: vpc });
    sg_service.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(3000));

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: fargateTaskDefinition,
      desiredCount: 2,
      assignPublicIp: false,
      securityGroups: [sg_service]
    });

    // Setup AutoScaling policy
    const scaling = service.autoScaleTaskCount({ maxCapacity: 6, minCapacity: 2 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
      scaleInCooldown: Duration.seconds(60),
      scaleOutCooldown: Duration.seconds(60)
    });


    const lb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
    });

    const listener = lb.addListener('Listener', {
      port: 80,
    });

    listener.addTargets('Target', {
      port: 80,
      targets: [service],
      healthCheck: { path: '/api/' }
    });

    listener.connections.allowDefaultPortFromAnyIpv4('Open to the world');


    const gitHubSource = codebuild.Source.gitHub({
      owner: 'bravemang532532',
      repo: 'project1',
      webhook: true, // optional, default: true if `webhookfilteres` were provided, false otherwise
      webhookFilters: [
        codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('main'),
      ], // optional, by default all pushes and pull requests will trigger a build
    });



    // const project = new codebuild.PipelineProject(this, 'MyProject', {
    //   projectName: `${this.stackName}`,
    //   source: gitHubSource,
    //   environment: {
    //     buildImage: codebuild.LinuxBuildImage.STANDARD_2_0,
    //     privileged: true
    //   },
    // });
    const project = new codebuild.Project(this, 'myProject', {
      projectName: `${this.stackName}`,
      source: gitHubSource,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_2,
        privileged: true
      },
      environmentVariables: {
        'cluster_name': {
          value: `${cluster.clusterName}`
        },
        'ecr_repo_uri': {
          value: `${repository.repositoryUri}`
        }
      },
      badge: true,
      // TODO - I had to hardcode tag here
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            /*
            commands: [
              'env',
              'export tag=${CODEBUILD_RESOLVED_SOURCE_VERSION}'
            ]
            */
            commands: [
              'env',
              'export tag=latest'
            ]
          },
          build: {
            commands: [
              'cd flask-docker-app',
              `docker build -t $ecr_repo_uri:$tag .`,
              '$(aws ecr get-login --no-include-email)',
              'docker push $ecr_repo_uri:$tag'
            ]
          },
          post_build: {
            commands: [
              'echo "in post-build stage"',
              'cd ..',
              "printf '[{\"name\":\"flask-app\",\"imageUri\":\"%s\"}]' $ecr_repo_uri:$tag > imagedefinitions.json",
              "pwd; ls -al; cat imagedefinitions.json"
            ]
          }
        },
        artifacts: {
          files: [
            'imagedefinitions.json'
          ]
        }
      })
    });


    const buildRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:GetRepositoryPolicy",
        "ecr:DescribeRepositories",
        "ecr:ListImages",
        "ecr:DescribeImages",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ]
    });
    project.addToRolePolicy(buildRolePolicy);


    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();
    const nameOfGithubPersonTokenParameterAsString = githubPersonalTokenSecretName.valueAsString

    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'github_source',
      owner: 'bravemang532532',
      repo: 'project1',
      branch: 'main',
      oauthToken: cdk.SecretValue.secretsManager("/my/github/token"),
      output: sourceOutput
    });



    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project,
      input: sourceOutput,
      outputs: [buildOutput],
    });





    new codepipeline.Pipeline(this, 'ecs-pipeline', {
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'Build',
          actions: [buildAction],
        },
        {
          stageName: 'Deploy',
          actions: [
            new codepipeline_actions.EcsDeployAction({
              actionName: "ECS-Service",
              service: service,
              input: buildOutput
            }
            )
          ]
        }
      ],
    });


    // new codepipeline.Pipeline(this, 'asc-shopify-pipeline', {
    //   stages: [
    //     {
    //       stageName: 'source',
    //       actions: [sourceAction],
    //     },
    //     {
    //       stageName: 'build',
    //       actions: [buildAction],
    //     },
    //     // {
    //     //   stageName: 'approve',
    //     //   actions: [manualApprovalAction],
    //     // },
    //     {
    //       stageName: 'Deploy',
    //       actions: [
    //         new codepipeline_actions.EcsDeployAction({
    //           actionName: "ECS-Service",
    //           service: service,
    //           input: buildOutput
    //         })
    //       ]
    //     }
    //   ]
    // })

    // repository.grantPullPush(project.role!)
    // project.addToRolePolicy(new iam.PolicyStatement({
    //   actions: [
    //     "ecs:describecluster",
    //     "ecr:getauthorizationtoken",
    //     "ecr:batchchecklayeravailability",
    //     "ecr:batchgetimage",
    //     "ecr:getdownloadurlforlayer"
    //   ],
    //   resources: [`${cluster.clusterArn}`],
    // }));

    // new cdk.CfnOutput(this, "image", { value: repository.repositoryUri + ":latest" })
    // new cdk.CfnOutput(this, 'loadbalancerdns', { value: lb.loadBalancerArn.loadBalancerDnsName });
  }
}

