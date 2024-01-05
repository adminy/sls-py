
// Note: this is only for x86 architecture, arm is not included here, source:
// https://github.com/awslabs/serverless-plugin-lambda-insights/blob/main/layerVersions.json
const accountToRegionVersions = {
	580247275435: {
	  30: ['eu-north-1'],
	  31: ['ap-south-1'],
	  32: ['ap-northeast-2', 'ca-central-1', 'eu-west-3', 'sa-east-1'],
	  33: ['ap-southeast-1', 'ap-southeast-2', 'eu-west-1', 'eu-west-2', 'us-east-2', 'us-west-1', 'us-west-2'],
	  35: ['us-east-1', 'eu-central-1'],
	  50: ['ap-northeast-1'],
	},
	'012438385374': { 25: ['af-south-1'] },
	519774774795: { 25: ['ap-east-1'] },
	891564319516: { 8: ['ap-south-2'] },
	439286490199: { 11: ['ap-southeast-3'] },
	194566237122: { 2: ['ap-northeast-3'] },
	488211338238: { 26: ['cn-north-1', 'cn-northwest-1'] },
	339249233099: { 25: ['eu-south-1'] },
	352183217350: { 10: ['eu-south-2'] },
	'033019950311': { 7: ['eu-central-2'] },
	285320876703: { 25: ['me-south-1'] },
	732604637566: { 9: ['me-central-1'] }
}

export const lambdaInsightsManagedPolicy = 'arn:aws:iam::aws:policy/CloudWatchLambdaInsightsExecutionRolePolicy'

export const getInsightsLayer = region => {
	for (const account in accountToRegionVersions) {
		for (const version in accountToRegionVersions[account]) {
			if (accountToRegionVersions[account][version].includes(region)) {
				return `arn:aws:lambda:${region}:${account}:layer:LambdaInsightsExtension:${version}`
			}
		}
	}
	return 'arn:aws:lambda:us-east-1:580247275435:layer:LambdaInsightsExtension:35'
}
