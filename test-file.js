/* S-CORE CONFIDENTIAL
 * -------------------
 * Copyright (c) 2016 S-Core Co., Ltd. All rights reserved.
 *
 * All information contained herein is the property of S-Core.
 * Please see LICENSE file in source package.
 *
 */

'use strict';

// node modules
var express = require('express');
var Promise = require('bluebird');
var _ = require('lodash');

// webida modules
var authMgr = require('../../../common/auth-manager');
var logger = require('../../../common/logger-factory').getLogger('JSA ROUTER');

// jsa modules
var constants = require('./constants');
var jsaManager = require('./jsa-manager');
var JsaError = require('../common/jsa-error');

var entryRouter = new express.Router();
var mainRouter = new express.Router();
var exitRouter = new express.Router();

var FORMAT_JSON = 'json';
var DEFECT_STATUS_OUTSTANDING_LABEL = 'Outstanding';
var DEFECT_STATUS_DISMISSED_LABEL = 'Dismissed';
var DEFECT_STATUS_FIXED_LABEL = 'Fixed';
var DEFECT_STATUS_EXCLUDED_LABEL = 'Excluded';
var DEFECT_CLASSIFICATION_UNCLASSIFIED_LABEL = 'Unclassified';
var DEFECT_CLASSIFICATION_FALSE_POSITIVE_LABEL = 'FalsePositive';
var DEFECT_CLASSIFICATION_INTENTIONAL_LABEL = 'Intentional';

var DEFECTS = 'defects';
var DEFAULT_DEFECTS_OFFSET = 0;
var DEFAULT_DEFECTS_LIMIT = 30;

var defectsOrderMap = ['Did', 'OwnerPid', 'Impact', 'Filepath', 'Message', 'Name', 'Status'];
/**
 * Gets defects selection option.
 *
 * @param {object} selectionQuery A selection query.
 * @param {string} selectionQuery.id A stringified array containing ID.
 * @param {string} selectionQuery.ownerBranchId A stringified array containing owner branch ID.
 * @param {string} selectionQuery.name A stringified array containing name.
 * @param {string} selectionQuery.impact A stringified array containing impact.
 * @param {string} selectionQuery.filePath A stringified array containing file path.
 * @param {string} selectionQuery.firstDetectedAnalysisId A stringified array containing first detected analysis ID.
 * @param {string} selectionQuery.lastDetectedAnalysisId A stringified array containing last detected analysis ID.
 * @param {string} selectionQuery.eliminatedAnalysisId A stringified array containing eliminated analysis ID.
 * @param {string} selectionQuery.status A stringified array containing status.
 * @param {string} selectionQuery.classification A stringified array containing classification.
 * @param {string} selectionQuery.action A stringified array containing action.
 * @param {string} selectionQuery.owner A stringified array containing owner.
 * @param {string} selectionQuery.order A sort option.
 * @param {string} selectionQuery.format A format, one of the following values: json | csv | excel.
 * @returns {object} Defects selection option.
 */
function getDefectsSelectionOption(selectionQuery) {
    var optionToQueryMap = {
        id: 'ids',
        ownerBranchId: 'ownerBranchIds',
        impact: 'impacts',
        name: 'names',
        filePath: 'filePaths',
        firstDetectedAnalysisId: 'firstDetectedAnalysisIds',
        lastDetectedAnalysisId: 'lastDetectedAnalysisIds',
        eliminatedAnalysisId: 'eliminatedAnalysisIds',
        status: 'statuses',
        classification: 'classifications',
        action: 'actions',
        owner: 'owners',
        offset: 'offset',
        limit: 'limit'
    };

    var selectionOption = {
        statuses: [constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED, constants.LITE_DEFECT_STATUS_DISMISSED, constants.LITE_DEFECT_STATUS_FIXED]
    };
    logger.debug('[getDefectsSelectionOption selectionQuery]', selectionQuery);

    var keys = Object.keys(optionToQueryMap);
    keys.forEach(function (key) {
        if (selectionQuery.hasOwnProperty(key)) {
            var value = selectionQuery[key];
            if (value) {
                var parsedValue = value.split(',');
                if (parsedValue && parsedValue.length > 0) {
                    if (key === 'status') {
                        parsedValue = parsedValue.reduce(function (statuses, status) {
                            if (status === DEFECT_STATUS_OUTSTANDING_LABEL) {
                                statuses = statuses.concat([constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED]);
                            } else if (status === DEFECT_STATUS_DISMISSED_LABEL) {
                                statuses.push(constants.LITE_DEFECT_STATUS_DISMISSED);
                            } else if (status === DEFECT_STATUS_FIXED_LABEL) {
                                statuses.push(constants.LITE_DEFECT_STATUS_FIXED);
                            } else if (status === DEFECT_STATUS_EXCLUDED_LABEL) {
                                statuses.push(constants.LITE_DEFECT_STATUS_EXCLUDED);
                                selectionOption.excludedBySettings = 1;
                            } else {
                                throw new JsaError('Requested status (' + status + ') is not supported.', 400);
                            }

                            return statuses;
                        }, []);
                    } else if (key === 'classification') {
                        parsedValue = parsedValue.map(function (classification) {
                            if (classification === DEFECT_CLASSIFICATION_UNCLASSIFIED_LABEL) {
                                return constants.LITE_DEFECT_CLASSIFICATION_UNCLASSIFIED;
                            } else if (classification === DEFECT_CLASSIFICATION_FALSE_POSITIVE_LABEL) {
                                return constants.LITE_DEFECT_CLASSIFICATION_FALSE_POSITIVE;
                            } else if (classification === DEFECT_CLASSIFICATION_INTENTIONAL_LABEL) {
                                return constants.LITE_DEFECT_CLASSIFICATION_INTENTIONAL;
                            } else {
                                throw new JsaError('Requested classification (' + classification + ') is not supported.', 400);
                            }
                        });
                    }
                    selectionOption[optionToQueryMap[key]] = parsedValue;
                }
            }
        }
    });

    var order = selectionQuery.order;
    if (order) {
        var isDesc = false;

        if (order.startsWith('-')) {
            isDesc = true;
            order = order.substring(1);
        } else if (order.startsWith(' ') || order.startsWith('+')) {    // '+'는 Node에서 url.parse()로 query 객체를 만들 때 ' ' 로 변환됨
            order = order.substring(1);
        }

        if (order.match(/id/i)) {
            order = 'Did';
        } else if (order.match(/ownerBranchId/i)) {
            order = 'OwnerBid';
        } else {
            order = _.capitalize(order.toLowerCase());
        }

        // set orderBy option
        if (_.includes(defectsOrderMap, order)) {
            var key = 'orderBy' + order;

            // ex) selectionOption.orderByImpact = true;
            selectionOption[key] = true;

            // order를 설정할 경우 desc 옵션도 설정
            selectionOption.isDesc = isDesc;
        }
    }

    selectionOption.format = selectionQuery.format;

    var offset = parseInt(selectionQuery.offset, 10);
    var limit = parseInt(selectionQuery.limit, 10);
    selectionOption.offset = offset ? offset : DEFAULT_DEFECTS_OFFSET;
    selectionOption.limit = limit ? limit : DEFAULT_DEFECTS_LIMIT;

    if (!selectionOption.hasOwnProperty('excludedBySettings')) {
        selectionOption.notExcludedBySettings = 1;
    }
    logger.debug('[getDefectsSelectionOption selectionOption]', selectionOption);
    return selectionOption;
}

// Gets RepositoryInfos.
mainRouter['get']('/api/github/repos/', authMgr.ensureLogin, function (req, res, next) {
    req.resultPromise = jsaManager.getGitHubRepositoryInfos(req.session.githubAccessToken);

    return next();
});

// Gets ProjectInfos.
mainRouter['get']('/api/projects/', authMgr.ensureLogin, function (req, res, next) {
    req.resultPromise = jsaManager.getProjectInfos(req.user.userId);
    return next();
});

// Creates a project.
mainRouter['post']('/api/projects/', authMgr.ensureLogin, function (req, res, next) {
    var projectInfo = req.body;
    projectInfo.ownerUid = req.user.userId;

    req.resultPromise = jsaManager.createProject(projectInfo);
    return next();
});

// Delete All projects.
mainRouter['delete']('/api/projects/', authMgr.ensureLogin, function (req, res, next) {
    req.resultPromise = jsaManager.deleteProjectsOfUser(req.user.userId);
    return next();
});

// Deletes a project.
mainRouter['delete']('/api/projects/:projectId', authMgr.ensureLogin, function (req, res, next) {
    var uid = req.user.userId;
    var projectId = req.params.projectId;

    req.resultPromise = jsaManager.deleteProject(uid, projectId);
    return next();
});

// Gets a ProjectInfo.
mainRouter['get']('/api/projects/:projectId', function (req, res, next) {
    var projectId = req.params.projectId;

    // /api/projects/defects API로 bypass
    if (projectId === DEFECTS) {
        return next();
    }

    req.resultPromise = jsaManager.getProjectInfo(projectId);
    return next();
});

// Sets a ProjectInfo.
mainRouter['put']('/api/projects/:projectId', authMgr.ensureLogin, function (req, res, next) {
    var uid = req.user.userId;
    var projectId = req.params.projectId;
    var projectInfo = req.body;

    req.resultPromise = jsaManager.setProjectInfo(uid, projectId, projectInfo);
    return next();
});

// Gets branch list in remote.
mainRouter['get']('/api/projects/:projectId/remote/branches', authMgr.ensureLogin, function (req, res, next) {
    var uid = req.user.userId;
    var projectId = req.params.projectId;

    req.resultPromise = jsaManager.getRemoteBranchInfos(uid, projectId);
    return next();
});

// Creates a branch.
mainRouter['post']('/api/projects/:projectId/branches', authMgr.ensureLogin, function (req, res, next) {
    var uid = req.user.userId;
    var projectId = req.params.projectId;
    var branchInfo = req.body;

    logger.debug('[Creates a branch]', branchInfo);

    req.resultPromise = jsaManager.createBranch(projectId, branchInfo);
    return next();
});

// Gets BranchInfos.
mainRouter['get']('/api/projects/:projectId/branches', function (req, res, next) {
    var projectId = req.params.projectId;

    req.resultPromise = jsaManager.getBranchInfos(projectId);
    return next();
});

// Deletes a branch.
mainRouter['delete']('/api/projects/:projectId/branches/:branchId', authMgr.ensureLogin, function (req, res, next) {
    var uid = req.user.userId;
    var projectId = req.params.projectId;
    var branchId = req.params.branchId;

    req.resultPromise = jsaManager.deleteBranch(uid, projectId, branchId);
    return next();
});

// Gets a BranchInfo.
mainRouter['get']('/api/projects/:projectId/branches/:branchId', function (req, res, next) {
    var projectId = req.params.projectId;
    var branchId = req.params.branchId;

    req.resultPromise = jsaManager.getBranchInfo(projectId, branchId);
    return next();
});

// Sets a BranchInfo. (start and stop an analysis)
mainRouter['put']('/api/projects/:projectId/branches/:branchId', authMgr.ensureLogin, function (req, res, next) {
    var uid = req.user.userId;
    var branchId = req.params.branchId;
    var branchInfo = req.body;

    if (!branchInfo.status) {
        req.resultPromise = jsaManager.setBranchInfo(uid, branchId, branchInfo);
    } else {
        // status에 값이 있으면 start/stop 동작만 가능. (브랜치 정보 업데이트 불가능.)
        req.resultPromise = Promise.resolve()
            .then(function () {
                if (branchInfo.status === 'start') {
                    return jsaManager.startAnalysis(branchId, branchInfo.commitId);
                } else if (branchInfo.status === 'stop'){
                    return jsaManager.stopAnalysis(branchId);
                } else {
                    throw new JsaError('Unexpected status: '+ branchInfo.status);
                }
            });
    }
    return next();
});

// Gets a branch status.
mainRouter['get']('/api/projects/:projectId/branches/:branchId/status', function (req, res, next) {
    var branchId = req.params.branchId;

    req.resultPromise = jsaManager.getStatus(branchId);
    return next();
});


// Gets AnalysisInfos.
mainRouter['get']('/api/projects/:projectId/branches/:branchId/analyses', function (req, res, next) {
    var branchId = req.params.branchId;

    req.resultPromise = jsaManager.getAnalysisInfos(branchId);
    return next();
});

// Deletes an analysis.
mainRouter['delete']('/api/projects/:projectId/branches/:branchId/analyses/:analysisId', authMgr.ensureLogin, function (req, res, next) {
    var uid = req.user.userId;
    var branchId = req.params.branchId;
    var analysisId = req.params.analysisId;

    req.resultPromise = jsaManager.deleteAnalysis(uid, branchId, analysisId);
    return next();
});

// Gets an AnalysisInfo.
mainRouter['get']('/api/projects/:projectId/branches/:branchId/analyses/:analysisId', function (req, res, next) {
    var analysisId = req.params.analysisId;

    req.resultPromise = jsaManager.getAnalysisInfo(analysisId);
    return next();
});

// Gets an analysis status.
mainRouter['get']('/api/projects/:projectId/branches/:branchId/analyses/:analysisId/status', function (req, res, next) {
    var analysisId = req.params.analysisId;

    req.resultPromise = jsaManager.getStatus(analysisId);
    return next();
});

// Gets DefectInfos of defects.
mainRouter['get']('/api/projects/:projectId/branches/:branchId/defects', function (req, res, next) {
    var branchId = req.params.branchId;
    var query = req.query;
    var option = getDefectsSelectionOption(query);

    req.resultPromise = jsaManager.getDefectsInfoOfBranch(branchId, option);
    return next();
});

// Gets a DefectInfo.
mainRouter['get']('/api/projects/:projectId/branches/:branchId/defects/:defectId', function (req, res, next) {
    var branchId = req.params.branchId;
    var defectId = req.params.defectId;

    req.resultPromise = jsaManager.getDefectInfoOfBranch(branchId, defectId);
    return next();
});

// Sets a DefectInfo.
mainRouter['put']('/api/projects/:projectId/branches/:branchId/defects/:defectId', authMgr.ensureLogin, function (req, res, next) {
    var uid = req.user.userId;
    var branchId = req.params.branchId;
    var defectId = req.params.defectId;
    var defectInfo = req.body;

    req.resultPromise = jsaManager.setDefectInfo(uid, branchId, defectId, defectInfo);
    return next();
});

// Sets multiple DefectInfo
mainRouter['put']('/api/projects/:projectId/branches/:branchId/defects', authMgr.ensureLogin, function (req, res, next) {
    var uid = req.user.userId;
    var branchId = req.params.branchId;
    var defectInfos = req.body;

    req.resultPromise = jsaManager.setDefectInfos(uid, branchId, defectInfos);
    return next();
});

// Gets a project option.
mainRouter['get']('/api/projects/:projectId/options', authMgr.ensureLogin, function (req, res, next) {
    var projectId = req.params.projectId;

    req.resultPromise = jsaManager.getProjectSettings(projectId);
    return next();
});

// Sets a project option.
mainRouter['put']('/api/projects/:projectId/options', authMgr.ensureLogin, function (req, res, next) {
    var projectId = req.params.projectId;
    var option = req.body;

    logger.debug('[set option]', option);
    req.resultPromise = jsaManager.setProjectSettings(projectId, option);
    return next();
});

// Gets project rules.
mainRouter['get']('/api/projects/:projectId/rules', function (req, res, next) {
    var projectId = req.params.projectId;

    req.resultPromise = jsaManager.getProjectRules(projectId);
    return next();
});

// Sets a project rule.
mainRouter['put']('/api/projects/:projectId/rules/:ruleId', authMgr.ensureLogin, function (req, res, next) {
    var projectId = req.params.projectId;
    var ruleId = req.params.ruleId;
    var ruleInfo = req.body;

    req.resultPromise = jsaManager.setProjectRule(projectId, ruleId, ruleInfo);
    return next();
});

// Sets project rules.
mainRouter['put']('/api/projects/:projectId/rules', authMgr.ensureLogin, function (req, res, next) {
    var projectId = req.params.projectId;
    var ruleInfos = req.body;

    req.resultPromise = jsaManager.setProjectRules(projectId, ruleInfos);
    return next();
});

// Gets branch statistics
mainRouter['get']('/api/projects/:projectId/branches/:branchId/stat', function (req, res, next) {
    var branchId = req.params.branchId;
    var option = getDefectsSelectionOption(req.query);

    req.resultPromise = jsaManager.getStatisticsInfoOfBranch(branchId, option);
    return next();
});

mainRouter['get']('/api/self', function (req, res, next) {
    req.resultPromise = jsaManager.getJsaInfo();
    return next();
});

mainRouter['get']('/api/users', function (req, res, next) {
    req.resultPromise = jsaManager.getUsers();

    return next();
});

// Gets GitHub user information
mainRouter['get']('/api/github/user', authMgr.ensureLogin, function (req, res, next) {
    req.resultPromise = jsaManager.getGitHubUserInfo(req.session.githubAccessToken);

    return next();
});

// GitHub Webhook for push event
// After receiving the push event, auto analysis for the branch will start.
// TODO: Process for pull request
mainRouter['post']('/api/webhook/github', function (req, res, next) {
    var headers = req.headers;
    var body = req.body;
    var url = body.repository.clone_url;
    var commitId = body.head_commit.id;
    var branch = body.ref.split('/').pop();

    // github webhook secret이 설정된 경우 signature 값이 같아야 검증을 통과
    // Securing your webhooks and secure_compare reference: https://developer.github.com/webhooks/securing/
    if (headers['x-hub-signature']) {
        var crypto = require('crypto');
        var compare = require('secure-compare');

        // 환경변수의 SECRET_TOKEN(github에 설정된 값과 동일)과 body를 가지고 signature를 생성
        var secretToken = process.env.SECRET_TOKEN;
        var hmac = crypto.createHmac('sha1', secretToken);
        hmac.update(JSON.stringify(body));
        var signature = 'sha1=' + hmac.digest('hex');

        // 생성된 signature 값과 github에서 보내온 값을 비교
        if (compare(headers['x-hub-signature'], signature)) {
            if (headers['x-github-event'] === 'push') {
                req.resultPromise = jsaManager.autoAnalysis(url, branch, commitId);
            } else if (headers['x-github-event'] === 'pull_request') {
                logger.error('pull_request is not yet supported');
                req.resultPromise = Promise.reject(new JsaError('pull_request is not yet supported'));
            } else {
                logger.error('Unsupported event type');
                req.resultPromise = Promise.reject(new JsaError('Unsupported event type'));
            }
        } else {
            logger.error('Signatures didn\'t match!');
            req.resultPromise = Promise.reject(new JsaError('Signatures didn\'t match!'));
        }
    } else {
        // github webhook secret이 설정되지 않은 경우 악의적 사용을 막기 위해 에러 처리
        // ex> 사용자가 secret을 지운 후 curl로 접근 시도
        logger.error('Invalid access: webhook secret is required');
        req.resultPromise = Promise.reject(new JsaError('Invalid access: webhook secret is required'));
    }

    return next();
});

entryRouter['use']('/api', function (req, res, next) {
    logger.debug('[entryRouter]', '[' + req.method + ']', req.originalUrl);
    return next();
});

exitRouter['use']('/api', function (req, res) {
    logger.debug('[exitRouter]', '[' + req.method + ']', req.originalUrl);
    req.resultPromise.then(function (result) {
        // result 가 매우 크면 logger가 못찍고 에러발생할 수 있어서 logger로 출력하지 않도록 수정한다.
        // logger.debug('[exitRouter result]', result);
        res.sendok(result);
    }).catch(function (error) {
        if (error instanceof JsaError) {
            logger.error(error.message, error.statusCode, error.stack);
        } else {
            logger.error(error);
        }
        res.sendfail(error);
    });
});


module.exports.entryRouter = entryRouter;
module.exports.mainRouter = mainRouter;
module.exports.exitRouter = exitRouter;
