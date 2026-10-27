// The CloudFormation templates for things4good.xyz on S3 and CloudFront, written to infra/generated/ by
// `npm run infra:generate`. Three stacks, each deployed from this Mac as the cloud-engineer identity
// (`npm run infra -- <stack>`), never from CI:
//
//   certificate  things4good.xyz and www.things4good.xyz, validated by two CNAMEs at Namecheap
//   site         the bucket, the distribution and its function, headers, access logs, 5xx alarm
//   delivery     the role GitHub Actions assumes to publish a build (scripts/deploy-aws.mjs)
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
// The Thingelstad family alarm topic (the one poap, nnxyz, thingelstad.xyz and escape use too), subscribed to the shared projects-ops-alerts queue.
const alarmTopic = sub('arn:${AWS::Partition}:sns:us-east-1:${AWS::AccountId}:weekly-thing-librarian-alarms');
// AWS managed CachingOptimized: no cookies, headers or query strings in the key, so ?ref= and ?v= variants
// share one cached copy; it honours the Cache-Control each object is uploaded with.
const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';

const template = (Description, Resources, Outputs, extra = {}) => ({
  AWSTemplateFormatVersion: '2010-09-09',
  Description,
  ...extra,
  Resources,
  Outputs
});
const output = (Value) => ({ Value });

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
          SecurityHeadersConfig: {
            ContentTypeOptions: { Override: true },
            FrameOptions: { FrameOption: 'SAMEORIGIN', Override: true },
            ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
            StrictTransportSecurity: { AccessControlMaxAgeSec: 31536000, Override: true }
          }
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
          // A missing object is a 403 from S3 behind OAC (no ListBucket). Both become the site's 404 page.
          CustomErrorResponses: [
            { ErrorCode: 403, ResponseCode: 404, ResponsePagePath: '/404.html', ErrorCachingMinTTL: 60 },
            { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: '/404.html', ErrorCachingMinTTL: 60 }
          ]
        }
      }
    },
    // Access logs, the same shape as the other sites' (/weekly/web-access, /thingelstad-xyz/web-access):
    // CloudFront's vended delivery into CloudWatch Logs as JSON, kept 14 days, with no viewer IP and no
    // query string.
    AccessLogGroup: {
      Type: 'AWS::Logs::LogGroup',
      Properties: { LogGroupName: '/things4good/web-access', RetentionInDays: 14 }
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
    },
    DistributionErrorAlarm: {
      Type: 'AWS::CloudWatch::Alarm',
      Properties: {
        AlarmName: sub('${AWS::StackName}-distribution-5xx'),
        AlarmDescription: `CloudFront returned more than 5% 5xx responses for ${DOMAIN} in two of three five-minute windows.`,
        Namespace: 'AWS/CloudFront',
        MetricName: '5xxErrorRate',
        Dimensions: [
          { Name: 'DistributionId', Value: ref('Distribution') },
          { Name: 'Region', Value: 'Global' }
        ],
        Statistic: 'Average',
        Period: 300,
        EvaluationPeriods: 3,
        DatapointsToAlarm: 2,
        Threshold: 5,
        ComparisonOperator: 'GreaterThanThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: [alarmTopic]
      }
    }
  },
  {
    SiteBucket: output(ref('SiteBucket')),
    DistributionId: output(ref('Distribution')),
    CloudFrontDomain: output(get('Distribution', 'DomainName'))
  },
  {
    Parameters: { CertificateArn: { Type: 'String', Default: '' } },
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(dirname(fileURLToPath(import.meta.url)), 'generated');
  mkdirSync(out, { recursive: true });
  for (const [name, body] of Object.entries({ certificate, site, delivery }))
    writeFileSync(join(out, `${name}.json`), JSON.stringify(body, null, 2) + '\n');
}
