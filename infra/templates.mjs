// The CloudFormation templates for things4good.xyz on S3 and CloudFront, written to infra/generated/ by
// `npm run infra:generate`. Four stacks, each deployed from this Mac as the cloud-engineer identity
// (`npm run infra -- <stack>`), never from CI:
//
//   certificate  things4good.xyz and www.things4good.xyz, validated by two CNAMEs at Namecheap
//   site         the bucket, the distribution and its function, headers, access logs
//   delivery     the role GitHub Actions assumes to publish a build (scripts/deploy-aws.mjs)
//   orders       the candle order service behind /api/: its function, secret and alarm
//
// Things 4 Good is the family's candle fundraiser: listed in shared/sites.json only so
// cards.thingelstad.com can draw its share cards, outside the publishing system and the sites strip.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APEX, viewerRequestCode } from './viewer-request.mjs';

export const DOMAIN = APEX;
export const WWW = `www.${APEX}`;
const ref = (name) => ({ Ref: name });
const sub = (value) => ({ 'Fn::Sub': value });
const get = (name, field) => ({ 'Fn::GetAtt': [name, field] });
const custom = (a, b) => ({ 'Fn::If': ['CustomDomain', a, b] });
// AWS managed CachingOptimized: no cookies, headers or query strings in the key, so ?ref= and ?v= variants
// share one cached copy; it honours the Cache-Control each object is uploaded with.
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
// AWS managed AllViewerExceptHostHeader, meant for function URLs: the signature has to be for the URL's own
// name, so no viewer Host. It carries x-amz-content-sha256, which a policy of our own can't list, and
// CloudFront-Viewer-Address, used only for the service's rate limit and never logged.
const ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

const template = (Description, Resources, Outputs, extra = {}) => ({
  AWSTemplateFormatVersion: '2010-09-09',
  Description,
  ...extra,
  Resources,
  Outputs
});
const output = (Value) => ({ Value });
const SECURITY_HEADERS = {
  ContentTypeOptions: { Override: true },
  FrameOptions: { FrameOption: 'SAMEORIGIN', Override: true },
  ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
  StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, Override: true }
};

export const certificate = template(
  `${DOMAIN} HTTPS certificate - external DNS validation`,
  {
    Certificate: {
      Type: 'AWS::CertificateManager::Certificate',
      Properties: { DomainName: DOMAIN, SubjectAlternativeNames: [WWW], ValidationMethod: 'DNS' }
    }
  },
  { CertificateArn: output(ref('Certificate')) }
);

export const site = template(
  `${DOMAIN} static site - Things 4 Good, outside the publishing system`,
  {
    // Versioned, so an object a deploy deletes or overwrites can be restored.
    SiteBucket: {
      Type: 'AWS::S3::Bucket',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]
        },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        VersioningConfiguration: { Status: 'Enabled' },
        LifecycleConfiguration: {
          Rules: [{ Id: 'old-versions', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 90 } }]
        }
      }
    },
    SitePolicy: {
      Type: 'AWS::S3::BucketPolicy',
      Properties: {
        Bucket: ref('SiteBucket'),
        PolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 's3:GetObject',
              Resource: sub('${SiteBucket.Arn}/*'),
              Condition: {
                StringEquals: {
                  'AWS:SourceArn': sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}')
                }
              }
            }
          ]
        }
      }
    },
    OriginAccess: {
      Type: 'AWS::CloudFront::OriginAccessControl',
      Properties: {
        OriginAccessControlConfig: {
          Name: sub('${AWS::StackName}-s3'),
          OriginAccessControlOriginType: 's3',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4'
        }
      }
    },
    ViewerRequest: {
      Type: 'AWS::CloudFront::Function',
      Properties: {
        Name: sub('${AWS::StackName}-viewer-request'),
        AutoPublish: true,
        FunctionConfig: {
          Comment: 'www to the apex, the slash form, and index.html for directory URLs',
          Runtime: 'cloudfront-js-2.0'
        },
        FunctionCode: viewerRequestCode
      }
    },
    // GitHub Pages, the host until 2026-10-27, answered every file with Access-Control-Allow-Origin: *,
    // so this keeps that for llms.txt and anything else a tool may fetch from another site, and adds the
    // security headers.
    Headers: {
      Type: 'AWS::CloudFront::ResponseHeadersPolicy',
      Properties: {
        ResponseHeadersPolicyConfig: {
          Name: sub('${AWS::StackName}-headers'),
          CorsConfig: {
            AccessControlAllowCredentials: false,
            AccessControlAllowHeaders: { Items: ['*'] },
            AccessControlAllowMethods: { Items: ['GET', 'HEAD'] },
            AccessControlAllowOrigins: { Items: ['*'] },
            OriginOverride: true
          },
          SecurityHeadersConfig: SECURITY_HEADERS
        }
      }
    },
    // The order service (the orders stack). Its function URL takes only signed requests, and CloudFront
    // signs a POST only when the viewer sent the body's SHA-256 in x-amz-content-sha256, which the page does.
    OrderOriginAccess: {
      Type: 'AWS::CloudFront::OriginAccessControl',
      Properties: {
        OriginAccessControlConfig: {
          Name: sub('${AWS::StackName}-orders'),
          OriginAccessControlOriginType: 'lambda',
          SigningBehavior: 'always',
          SigningProtocol: 'sigv4'
        }
      }
    },
    // The security headers without the site's open CORS: only the site's own page uses this API.
    OrderHeaders: {
      Type: 'AWS::CloudFront::ResponseHeadersPolicy',
      Properties: {
        ResponseHeadersPolicyConfig: {
          Name: sub('${AWS::StackName}-orders'),
          SecurityHeadersConfig: SECURITY_HEADERS
        }
      }
    },
    Distribution: {
      Type: 'AWS::CloudFront::Distribution',
      Properties: {
        DistributionConfig: {
          Enabled: true,
          Comment: `${DOMAIN} - Things 4 Good`,
          PriceClass: 'PriceClass_100',
          IPV6Enabled: true,
          HttpVersion: 'http2and3',
          // The shared web ACL from projects-sysadmin's edge-waf stack, counting only until tuned.
          WebACLId: { 'Fn::ImportValue': 'edge-waf-WebAclArn' },
          DefaultRootObject: 'index.html',
          Aliases: custom([DOMAIN, WWW], ref('AWS::NoValue')),
          ViewerCertificate: custom(
            { AcmCertificateArn: ref('CertificateArn'), SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' },
            { CloudFrontDefaultCertificate: true }
          ),
          Origins: [
            {
              Id: 'site',
              DomainName: get('SiteBucket', 'RegionalDomainName'),
              OriginAccessControlId: ref('OriginAccess'),
              S3OriginConfig: { OriginAccessIdentity: '' }
            },
            {
              Id: 'orders',
              DomainName: ref('OrdersOriginDomain'),
              OriginAccessControlId: ref('OrderOriginAccess'),
              CustomOriginConfig: { OriginProtocolPolicy: 'https-only', OriginSSLProtocols: ['TLSv1.2'] }
            }
          ],
          DefaultCacheBehavior: {
            TargetOriginId: 'site',
            ViewerProtocolPolicy: 'redirect-to-https',
            AllowedMethods: ['GET', 'HEAD', 'OPTIONS'],
            CachedMethods: ['GET', 'HEAD'],
            Compress: true,
            CachePolicyId: CACHING_OPTIMIZED,
            ResponseHeadersPolicyId: ref('Headers'),
            FunctionAssociations: [{ EventType: 'viewer-request', FunctionARN: get('ViewerRequest', 'FunctionARN') }]
          },
          // No viewer-request function: it would send /api/stock to /api/stock/. The service sets its own
          // Cache-Control (a few minutes on stock, none on anything else) and CachingOptimized honours it.
          CacheBehaviors: [
            {
              PathPattern: '/api/*',
              TargetOriginId: 'orders',
              ViewerProtocolPolicy: 'https-only',
              AllowedMethods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'],
              CachedMethods: ['GET', 'HEAD'],
              Compress: true,
              CachePolicyId: CACHING_OPTIMIZED,
              OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
              ResponseHeadersPolicyId: ref('OrderHeaders')
            }
          ],
          // A missing object is a 403 from S3 behind OAC (no ListBucket). Both become the site's 404 page,
          // on every behavior, so the order service never answers with either.
          CustomErrorResponses: [
            { ErrorCode: 403, ResponseCode: 404, ResponsePagePath: '/404.html', ErrorCachingMinTTL: 60 },
            { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: '/404.html', ErrorCachingMinTTL: 60 }
          ]
        }
      }
    },
    // Access logs, the same shape as the other sites' (/weekly/web-access, /thingelstad-xyz/web-access):
    // CloudFront's vended delivery into CloudWatch Logs as JSON, kept 24 months (731 days), with no viewer IP and no
    // query string.
    AccessLogGroup: {
      Type: 'AWS::Logs::LogGroup',
      Properties: { LogGroupName: '/things4good/web-access', RetentionInDays: 731 }
    },
    AccessLogSource: {
      Type: 'AWS::Logs::DeliverySource',
      Properties: {
        Name: 'things4good-web-access',
        LogType: 'ACCESS_LOGS',
        ResourceArn: sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${Distribution}')
      }
    },
    AccessLogDestination: {
      Type: 'AWS::Logs::DeliveryDestination',
      Properties: {
        Name: 'things4good-web-access',
        DestinationResourceArn: get('AccessLogGroup', 'Arn'),
        OutputFormat: 'json'
      }
    },
    AccessLogDelivery: {
      Type: 'AWS::Logs::Delivery',
      DependsOn: 'AccessLogSource',
      Properties: {
        DeliverySourceName: 'things4good-web-access',
        DeliveryDestinationArn: get('AccessLogDestination', 'Arn'),
        RecordFields: [
          'timestamp(ms)',
          'cs-method',
          'cs-uri-stem',
          'sc-status',
          'sc-bytes',
          'sc-range-start',
          'sc-range-end',
          'time-taken',
          'time-to-first-byte',
          'x-edge-result-type',
          'x-edge-detailed-result-type',
          'x-edge-location',
          'cs-protocol',
          'cs(User-Agent)'
        ]
      }
    }
  },
  {
    SiteBucket: output(ref('SiteBucket')),
    DistributionId: output(ref('Distribution')),
    CloudFrontDomain: output(get('Distribution', 'DomainName'))
  },
  {
    Parameters: {
      CertificateArn: { Type: 'String', Default: '' },
      OrdersOriginDomain: { Type: 'String' }
    },
    Conditions: { CustomDomain: { 'Fn::Not': [{ 'Fn::Equals': [ref('CertificateArn'), ''] }] } }
  }
);

// Application delivery only: publish a build into the bucket and clear the cache. Infrastructure changes
// stay a separate, local deployment.
export const delivery = template(
  `${DOMAIN} GitHub application delivery - Things 4 Good, outside the publishing system`,
  {
    DeploymentRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: {
                Federated: sub('arn:${AWS::Partition}:iam::${AWS::AccountId}:oidc-provider/token.actions.githubusercontent.com')
              },
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                  // GitHub's immutable subject (owner and repository ids) and the named form, main only.
                  'token.actions.githubusercontent.com:sub': [
                    'repo:jthingelstad@5351/things4good.xyz@1258927586:ref:refs/heads/main',
                    'repo:jthingelstad/things4good.xyz:ref:refs/heads/main'
                  ]
                }
              }
            }
          ]
        },
        Policies: [
          {
            PolicyName: 'ApplicationDelivery',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: ['s3:ListBucket', 's3:GetBucketLocation'],
                  Resource: sub('arn:${AWS::Partition}:s3:::${SiteBucket}')
                },
                {
                  // Delete removes pages the build no longer writes; the bucket keeps 90 days of versions.
                  Effect: 'Allow',
                  Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
                  Resource: sub('arn:${AWS::Partition}:s3:::${SiteBucket}/*')
                },
                {
                  Effect: 'Allow',
                  Action: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation', 'cloudfront:GetDistribution'],
                  Resource: sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${DistributionId}')
                },
                {
                  // Read-only: the deploy refuses to publish unless the live template matches the generated one.
                  Effect: 'Allow',
                  Action: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
                  Resource: sub('arn:${AWS::Partition}:cloudformation:${AWS::Region}:${AWS::AccountId}:stack/${SiteStack}/*')
                }
              ]
            }
          }
        ]
      }
    }
  },
  { DeploymentRoleArn: output(get('DeploymentRole', 'Arn')) },
  {
    Parameters: {
      SiteStack: { Type: 'String' },
      SiteBucket: { Type: 'String' },
      DistributionId: { Type: 'String' }
    }
  }
);

// The candle order service (infra/order-service.mjs, whose code `npm run infra -- orders` uploads after
// the stack). Reserved concurrency 1 is what keeps a stock check and its write from overlapping.
const ORDERS_FUNCTION = 'things4good-orders';
export const orders = template(
  `${DOMAIN} candle order service - stock and orders in Grist, behind /api/`,
  {
    // Holds {"apiKey": ..., "docId": ...}, put there by hand (AGENTS.md, "Order service"). The generated
    // value is a placeholder, so the template never carries the key, and CloudFormation leaves the value
    // alone on later updates.
    Secret: {
      Type: 'AWS::SecretsManager::Secret',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        Name: 'things4good/orders/grist',
        Description: 'Grist API key and document id for the things4good order service',
        GenerateSecretString: {
          SecretStringTemplate: '{}',
          GenerateStringKey: 'placeholder',
          PasswordLength: 32,
          ExcludePunctuation: true
        }
      }
    },
    // Readable only by this function: nobody else in the account can read the value, the deploying
    // identity included. It can still put a new value.
    SecretPolicy: {
      Type: 'AWS::SecretsManager::ResourcePolicy',
      Properties: {
        SecretId: ref('Secret'),
        BlockPublicPolicy: true,
        ResourcePolicy: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'OnlyTheOrderFunctionReads',
              Effect: 'Deny',
              Principal: '*',
              Action: 'secretsmanager:GetSecretValue',
              Resource: '*',
              Condition: { StringNotEquals: { 'aws:PrincipalArn': get('Role', 'Arn') } }
            }
          ]
        }
      }
    },
    Logs: {
      Type: 'AWS::Logs::LogGroup',
      Properties: { LogGroupName: `/aws/lambda/${ORDERS_FUNCTION}`, RetentionInDays: 90 }
    },
    Role: {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }]
        },
        Policies: [
          {
            PolicyName: 'OrderService',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                  Resource: sub('${Logs.Arn}:*')
                },
                { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: ref('Secret') }
              ]
            }
          }
        ]
      }
    },
    Function: {
      Type: 'AWS::Lambda::Function',
      DependsOn: 'Logs',
      Properties: {
        FunctionName: ORDERS_FUNCTION,
        Description: 'Things 4 Good candle orders - stock and orders in Grist',
        Runtime: 'nodejs24.x',
        Architectures: ['arm64'],
        Handler: 'index.handler',
        MemorySize: 256,
        // Under CloudFront's 30 second wait for an origin.
        Timeout: 28,
        ReservedConcurrentExecutions: 1,
        Role: get('Role', 'Arn'),
        LoggingConfig: { LogFormat: 'JSON', LogGroup: ref('Logs') },
        Environment: { Variables: { ORDERS_OPEN: ref('OrdersOpen'), SECRET_ID: ref('Secret') } },
        // A stub until `npm run infra -- orders` uploads the code. CloudFormation leaves the uploaded code
        // alone as long as this text does not change.
        Code: {
          ZipFile:
            "exports.handler = async () => ({ statusCode: 503, headers: { 'content-type': 'application/json' }, body: '{\"open\":false}' });"
        }
      }
    },
    FunctionUrl: {
      Type: 'AWS::Lambda::Url',
      Properties: { TargetFunctionArn: ref('Function'), AuthType: 'AWS_IAM' }
    },
    // CloudFront needs both to call a function URL through origin access control.
    CloudFrontInvokeUrl: {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: ref('Function'),
        Action: 'lambda:InvokeFunctionUrl',
        FunctionUrlAuthType: 'AWS_IAM',
        Principal: 'cloudfront.amazonaws.com',
        SourceArn: sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${DistributionId}')
      }
    },
    CloudFrontInvoke: {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        FunctionName: ref('Function'),
        Action: 'lambda:InvokeFunction',
        Principal: 'cloudfront.amazonaws.com',
        SourceArn: sub('arn:${AWS::Partition}:cloudfront::${AWS::AccountId}:distribution/${DistributionId}')
      }
    },
    // The service logs what it caught at level ERROR (a failed Grist call, a rollback), and Lambda's own
    // Errors metric catches what it could not (a timeout, a crash). Either one alarms.
    ErrorFilter: {
      Type: 'AWS::Logs::MetricFilter',
      Properties: {
        LogGroupName: ref('Logs'),
        FilterPattern: '{ $.level = "ERROR" }',
        MetricTransformations: [{ MetricNamespace: 'things4good/orders', MetricName: 'ServiceErrors', MetricValue: '1' }]
      }
    },
    ErrorAlarm: {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        AlarmName: ORDERS_FUNCTION + '-errors',
        AlarmDescription: 'The things4good order service failed: a Grist call, a rollback, a timeout or a crash',
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        EvaluationPeriods: 1,
        Threshold: 1,
        TreatMissingData: 'notBreaching',
        AlarmActions: [sub('arn:${AWS::Partition}:sns:${AWS::Region}:${AWS::AccountId}:projects-sysadmin-alarms')],
        Metrics: [
          {
            Id: 'crashes',
            ReturnData: false,
            MetricStat: {
              Metric: {
                Namespace: 'AWS/Lambda',
                MetricName: 'Errors',
                Dimensions: [{ Name: 'FunctionName', Value: ref('Function') }]
              },
              Period: 300,
              Stat: 'Sum'
            }
          },
          {
            Id: 'caught',
            ReturnData: false,
            MetricStat: {
              Metric: { Namespace: 'things4good/orders', MetricName: 'ServiceErrors' },
              Period: 300,
              Stat: 'Sum'
            }
          },
          { Id: 'failures', Expression: 'FILL(crashes, 0) + FILL(caught, 0)', Label: 'Order service failures', ReturnData: true }
        ]
      }
    }
  },
  {
    FunctionName: output(ref('Function')),
    SecretArn: output(ref('Secret')),
    OrdersOriginDomain: output({ 'Fn::Select': [2, { 'Fn::Split': ['/', get('FunctionUrl', 'FunctionUrl')] }] })
  },
  {
    Parameters: {
      DistributionId: { Type: 'String' },
      OrdersOpen: { Type: 'String', AllowedValues: ['true', 'false'], Default: 'false' }
    }
  }
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(dirname(fileURLToPath(import.meta.url)), 'generated');
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries({ certificate, site, delivery, orders }))
    writeFileSync(join(out, `${name}.json`), JSON.stringify(body, null, 2) + '\n');
}
