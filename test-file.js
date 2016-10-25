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
var _ = require('underscore');
var path = require('path');
var Promise = require('bluebird');

// webida modules
var conf = require('../../../common/conf-manager').conf;
var fsMgr = require('../../../fs/lib/fs-manager');
var userdb = require('../../../auth/lib/userdb');
var logger = require('../../../common/logger-factory').getLogger('JSA MANAGER');

// jsa modules
var analyzer = require('./analyzer');
var constants = require('./constants');
var JsaGit = require('./jsa-git');

var defectExcluder = require('../common/defect-excluder');
var jsaDao = require('../common/jsa-dao');
var JsaError = require('../common/jsa-error');
var githubUtils = require('../common/github-utils');

var dbLiteProject = jsaDao.dbLiteProject;
var dbLiteProjectSettings = jsaDao.dbLiteProjectSettings;
var dbLiteBranch = jsaDao.dbLiteBranch;
var dbLiteDefect = jsaDao.dbLiteDefect;
var dbLiteAnalysis = jsaDao.dbLiteAnalysis;
var dbLiteAlarm = jsaDao.dbLiteAlarm;
var dbLiteRule = jsaDao.dbLiteRule;

var dbManager = jsaDao.dbManager;

var ANALYSIS_DIR_ROOT = 'analyses';
var WEBHOOK_URL = '/api/webhook/github';

/**
 * uid로 부터 fsid를 획득
 * @param {string} uid - user id
 * @return {object} promise - 성공 시 user의 fsid, 실패 시 error 메시지를 전달
 */
function getFsid(uid) {
    return new Promise(function (resolve, reject) {
        fsMgr.getFsinfosByUid(uid, function (err, result) {
            if (err) {
                reject('getFsid is failed(uid : ' + uid + ')');
            } else {
                resolve(result[0].wfsId);
            }
        });
    });
}

function getAnalysisRootDir(fsid) {
    logger.debug('[getAnalysisRootDir]', fsid);
    return path.normalize(path.join(conf.services.fs.fsPath, fsid, ANALYSIS_DIR_ROOT));
}

// '/home/webida/fs/xkADkKcOW/analyses/'+ aid;
function getSourcePath(fsid, aid) {
    logger.debug('[getSourcePath]', fsid, aid);
    return path.normalize(path.join(getAnalysisRootDir(fsid), aid.toString()));
}

function canAccessProject(userId, projectInfo) {
    //FIXME : 현재는 API 사용자의 프로젝트만 접근 가능. 프로젝트 공유 기능이 생기면 반드시 이 부분을 업데이트 해야 함.
    if (userId !== projectInfo.ownerUid) {
        throw new JsaError('You don\'t have permission to access the project (' + projectInfo.pid + ')', 403);
    } else {
        Promise.resolve();
    }
}

function getInprogressAnalysesOfBranch(branchId) {
    return dbLiteAnalysis.getAnalysesInProgressAsync({
        ownerBid: branchId
    }).then(function (context) {
        var rows = context.result();
        if (rows.length > 0) {
            return rows;
        }
        return null;
    });
}

function createLiteProjectInfoFromSQLRow(row) {
    return {
        id: row.pid,
        type: row.type,
        name: row.name,
        url: row.url,
        lastBid: row.lastBid
    };
}

function createLiteProjectSettingsInfoFromSQLRow(row) {
    return {
        id: row.psid,
        watching: row.watching,
        notificationEmails: row.notificationEmails,
        ignoreFiles: row.ignoreFiles
    };
}

function createLiteBranchInfoFromSQLRow(row) {
    return {
        id: row.bid,
        name: row.name,
        badgeAlias: row.badgeAlias,
        lastAid: row.lastAid
    };
}

function createLiteAnalysisInfoFromSQLRow(row) {
    return {
        id: row.aid,
        gitCommitId: row.gitCommitId,
        path: row.path,
        files: JSON.parse(row.files),
        startTime: row.startTime,
        endTime: row.endTime,
        status: row.status,
        grade: row.grade,
        totalDefectCount: row.totalDefectCount,
        outstandingDefectCount: row.outstandingDefectCount
    };
}

function createLiteDefectInfoFromSQLRow(row) {
    return {
        id: row.did,
        branchId: row.ownerBid,
        name: row.name,
        impact: row.impact,
        message: row.message,
        path: row.path,
        location: row.location,
        codeFragment: row.codeFragment,
        codeFragmentLocation: JSON.parse(row.codeFragmentLocation),
        firstDetectedAnalysisId: row.firstDetectedAnalysisId,
        lastDetectedAnalysisId: row.lastDetectedAnalysisId,
        eliminatedAnalysisId: row.eliminatedAnalysisId,
        status: row.status,
        classification: row.classification,
        action: row.action,
        owner: row.owner
    };
}

function createLiteAlarmInfoFromSQLRow(row) {
    return {
        id: row.alarmId,
        ownerDid: row.ownerDid,
        path: row.path,
        location: row.location,
        codeFragment: row.codeFragment,
        codeFragmentLocation: JSON.parse(row.codeFragmentLocation)
    };
}

function createLiteRuleInfoFromSQLRow(row) {
    return {
        id: row.id,
        name: row.name,
        impacts: JSON.parse(row.impacts),
        summaryKo: row.summaryKo,
        summaryEn: row.summaryEn,
        descriptionKo: row.descriptionKo,
        descriptionEn: row.descriptionEn,
        category: row.category,
        enabled: row.enabled,
        environment: row.environment,
        cwes: JSON.parse(row.cwes),
        since: row.since,
        examples: row.examples
    };
}

function createUpdateInfoAboutDefect(defectInfo) {
    var updateInfo = {};
    if (defectInfo.hasOwnProperty('classification')) {
        updateInfo.classification = parseInt(defectInfo.classification, 10);
        if (updateInfo.classification === constants.LITE_DEFECT_CLASSIFICATION_FALSE_POSITIVE ||
            updateInfo.classification === constants.LITE_DEFECT_CLASSIFICATION_INTENTIONAL) {
            updateInfo.status = constants.LITE_DEFECT_STATUS_DISMISSED;
        } else if (updateInfo.classification === constants.LITE_DEFECT_CLASSIFICATION_UNCLASSIFIED) {
            updateInfo.status = constants.LITE_DEFECT_STATUS_TRIAGED;
        }
    }

    if (defectInfo.hasOwnProperty('action')) {
        updateInfo.action = defectInfo.action;
    }

    if (defectInfo.hasOwnProperty('owner')) {
        updateInfo.owner = defectInfo.owner;
    }

    return updateInfo;
}

function createStatisticsInfo(ownerBid, option) {
    var statisticsInfo = {
        newlyDefects: {},
        currentDefects: {},
        totalDefects: {}
    };

    var param = {
        ownerBid: ownerBid
    };

    return dbLiteAnalysis.getLastAnalysisAsync(param).then(function (context) {
        var rows = context.result();
        var lastAnalysis = rows[0];
        var prevAnalysis = rows[1];
        if (!lastAnalysis) {
            // 분석을 한번도 하지 않은 경우
            logger.debug('[statisticsInfo]', statisticsInfo);
            return statisticsInfo;
        }
        // 마지막 분석이 있는 경우
        var newlyOption = _.clone(option);
        var outstandingOption = _.clone(option);
        var outstandingGroupByCategoryOption = _.clone(option);
        var nonExcludedOption = _.clone(option);
        var nonExcludedGroupByStatusOption = _.clone(option);
        var nonExcludedGroupByNameOption = _.clone(option);
        var nonExcludeGroupByImpactOption = _.clone(option);
        var nonExcludeGroupByFilePathOption = _.clone(option);

        newlyOption.firstDetectedAnalysisIds = [lastAnalysis.aid];

        outstandingOption.statuses = [constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED];
        outstandingOption.notExcludedBySettings = 1;

        outstandingGroupByCategoryOption.statuses = [constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED];
        outstandingGroupByCategoryOption.notExcludedBySettings = 1;
        outstandingGroupByCategoryOption.groupByCategory = 1;

        nonExcludedOption.statuses = [constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED, constants.LITE_DEFECT_STATUS_DISMISSED, constants.LITE_DEFECT_STATUS_FIXED];
        if (_.contains(nonExcludedOption.status, constants.DEFECT_STATUS_EXCLUDED)) {
            nonExcludedOption.excludedBySettings = 1;
        } else {
            nonExcludedOption.notExcludedBySettings = 1;
        }

        nonExcludedGroupByStatusOption.statuses = [constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED, constants.LITE_DEFECT_STATUS_DISMISSED, constants.LITE_DEFECT_STATUS_FIXED];
        if (_.contains(nonExcludedGroupByStatusOption.status, constants.DEFECT_STATUS_EXCLUDED)) {
            nonExcludedGroupByStatusOption.excludedBySettings = 1;
        } else {
            nonExcludedGroupByStatusOption.notExcludedBySettings = 1;
        }
        nonExcludedGroupByStatusOption.groupByStatus = 1;

        nonExcludedGroupByNameOption.statuses = [constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED, constants.LITE_DEFECT_STATUS_DISMISSED, constants.LITE_DEFECT_STATUS_FIXED];
        if (_.contains(nonExcludedGroupByNameOption.status, constants.DEFECT_STATUS_EXCLUDED)) {
            nonExcludedGroupByNameOption.excludedBySettings = 1;
        } else {
            nonExcludedGroupByNameOption.notExcludedBySettings = 1;
        }
        nonExcludedGroupByNameOption.groupByName = 1;

        nonExcludeGroupByImpactOption.statuses = [constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED, constants.LITE_DEFECT_STATUS_DISMISSED, constants.LITE_DEFECT_STATUS_FIXED];
        if (_.contains(nonExcludeGroupByImpactOption.status, constants.DEFECT_STATUS_EXCLUDED)) {
            nonExcludeGroupByImpactOption.excludedBySettings = 1;
        } else {
            nonExcludeGroupByImpactOption.notExcludedBySettings = 1;
        }
        nonExcludeGroupByImpactOption.groupByImpact = 1;


        nonExcludeGroupByFilePathOption.statuses = [constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED, constants.LITE_DEFECT_STATUS_DISMISSED, constants.LITE_DEFECT_STATUS_FIXED];
        if (_.contains(nonExcludeGroupByFilePathOption.status, constants.DEFECT_STATUS_EXCLUDED)) {
            nonExcludeGroupByFilePathOption.excludedBySettings = 1;
        } else {
            nonExcludeGroupByFilePathOption.notExcludedBySettings = 1;
        }
        nonExcludeGroupByFilePathOption.groupByFilePath = 1;


        var jobs = [dbLiteDefect.getDefectsCountAsync(newlyOption),
                    dbLiteDefect.getDefectsCountAsync(outstandingOption),
                    dbLiteDefect.getDefectsCountAsync(outstandingGroupByCategoryOption),
                    dbLiteDefect.getDefectsCountAsync(nonExcludedOption),
                    dbLiteDefect.getDefectsCountAsync(nonExcludedGroupByStatusOption),
                    dbLiteDefect.getDefectsCountAsync(nonExcludedGroupByNameOption),
                    dbLiteDefect.getDefectsCountAsync(nonExcludeGroupByImpactOption),
                    dbLiteDefect.getDefectsCountAsync(nonExcludeGroupByFilePathOption)];

        return Promise.all(jobs).spread(function (ctx1, ctx2, ctx3, ctx4, ctx5, ctx6, ctx7, ctx8) {
            var rows = ctx1.result();
            statisticsInfo.newlyDefects.count = rows[0].count;
            statisticsInfo.newlyDefects.prevAnalysisTime = prevAnalysis ? prevAnalysis.startTime : null;

            rows = ctx2.result();
            statisticsInfo.currentDefects.count = rows[0].count;

            rows = ctx3.result();
            statisticsInfo.currentDefects.byCategory = _.object(_.pluck(rows, 'category'), _.pluck(rows, 'count'));

            rows = ctx4.result();
            statisticsInfo.totalDefects.count = rows[0].count;

            rows = ctx5.result();
            statisticsInfo.totalDefects.byStatus = _.object(_.pluck(rows, 'status'), _.pluck(rows, 'count'));

            rows = ctx6.result();
            statisticsInfo.totalDefects.byName = _.object(_.pluck(rows, 'name'), _.pluck(rows, 'count'));

            rows = ctx7.result();
            statisticsInfo.totalDefects.byImpact = _.object(_.pluck(rows, 'impact'), _.pluck(rows, 'count'));

            rows = ctx8.result();
            statisticsInfo.totalDefects.byFilePath = _.object(_.pluck(rows, 'path'), _.pluck(rows, 'count'));

            logger.debug('[statisticsInfo]', statisticsInfo);
            return statisticsInfo;
        });
    });
}

function createRemoteBranchInfos(remotes) {
    if (!remotes || remotes.length === 0) {
        return Promise.resolve(null);
    } else {
        return Promise.map(remotes.trim().split('\n'), function (remote) {
            var info = remote.split(/[ \t]+/g);
            return {
                name: info[1],
                lastCommitId: info[0]
            };
        });
    }
}

/**
 * 분석 데이터 객체들을 생성하고 관리하는 REST API 핸들러들 모음
 * 아래 모든 핸들러는 Promise 객체를 리턴한다.
 */
var jsaManager = {
    /**
     * 프로젝트 생성
     * @param {object} projectInfo. An info of project.
     * @param {string} projectInfo.ownerUid A owner user id of project.
     * @param {string} projectInfo.type A type of project.
     * @param {string} projectInfo.name A name of project.
     * @param {string} projectInfo.url A git url of project.
     */
    createProject: function (projectInfo) {
        var tasks = [
            dbLiteProject.$save(projectInfo),
            function (context, next) {
                var row = context.result();
                var pid = row.insertId;
                context.data('pid', pid);
                next();
            },
            function (context, next) {
                dbLiteProjectSettings.$save({
                    ownerPid: context.data('pid')
                }, next, context);
            },
            function (context, next) {
                dbLiteProjectSettings.updateWithProjectOwnerEmail({
                    ownerPid: context.data('pid')
                }, next, context);
            },
            function (context, next) {
                dbLiteRule.duplicateRules({
                    ownerPid: context.data('pid')
                }, next, context);
            },
        ];

        return dbManager.transactionAsync(tasks).then(function (context) {
            return dbLiteProject.$findAsync({
                pid: context.data('pid')
            }).then(function (context) {
                var rows = context.result();
                if (rows && rows[0]) {
                    return createLiteProjectInfoFromSQLRow(rows[0]);
                } else {
                    throw new JsaError('Requested project (' + context.data('pid') + ') does not exist.', 404);
                }
            });
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * 프로젝트 삭제
     * @param {string} uid - User ID
     * @param {string} pid - 프로젝트 ID
     */
    deleteProject: function (uid, pid) {
        return dbLiteProject.$removeAsync({
                pid: pid
            }).then(function (context) {
                return;
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 사용자의 모든 프로젝트 삭제
     * @param {string} uid - User ID
     */
    deleteProjectsOfUser: function (uid) {
        logger.info('Delete projects of user. User ID: ', uid);
        return dbLiteProject.deleteProjectsOfUserAsync({ ownerUid: uid })
            .then(function (context) {
                logger.info('Deleted projects of user successfully.');
                return;
            })
            .catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 사용자가 접근 가능한 모든 프로젝트들 정보 획득
     * @param {string} uid - User ID
     */
    getProjectInfos: function (uid) {
        return dbLiteProject.$findAsync({
                ownerUid: uid
            }).then(function (context) {
                var rows = context.result();
                return Promise.map(rows, function (row) {
                    var pid = row.pid;
                    return dbLiteProject.getProjectWithLastBranchAsync({
                            pid: pid
                        }).then(function (context) {
                            var rows = context.result();
                            if (rows && rows[0]) {
                                return createLiteProjectInfoFromSQLRow(rows[0]);
                            } else {
                                throw new JsaError('Requested project (' + pid + ') does not exist.', 404);
                            }
                        });
                });
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 특정 프로젝트의 정보 획득
     * @param {string} pid - 프로젝트 ID
     */
    getProjectInfo: function (pid) {
        return dbLiteProject.getProjectWithLastBranchAsync({
                pid: pid
            }).then(function (context) {
                var rows = context.result();
                if (rows && rows[0]) {
                    return createLiteProjectInfoFromSQLRow(rows[0]);
                } else {
                    throw new JsaError('Requested project (' + pid + ') does not exist.', 404);
                }
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 특정 프로젝트의 정보 설정
     * @param {string} uid - User ID
     * @param {string} pid - 프로젝트 ID
     * @param {object} projectInfo - 설정할 프로젝트 정보
     */
    setProjectInfo: function (uid, pid, projectInfo) {
        return dbLiteProject.$updateAsync({
            pid: pid,
            $set: projectInfo
        }).then(function (context) {
            return;
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * Checks whether project corresponding ID exists and can access.
     *
     * @param {string} userId An uid of user
     * @param {string} projectId An ID of project
     * @returns {Promise} Promise resolves undefined, rejects JsaError object
     */
    checkProject: function (userId, projectId) {
        return dbLiteProject.$findOneAsync({
                pid: projectId
            }).then(function (context) {
                var projectInfo = context.result();
                if (!projectInfo) {
                    throw new JsaError('Requested project (' + projectId + ') does not exist.', 404);
                } else {
                    return canAccessProject(userId, projectInfo);
                }
            });
    },

    /**
     * Gets an array containing GitHub repository information
     *
     * @param {string} accessToken An access token of GitHub
     * @return {Promise} - a promise that is resolved with an array of repository
     */
    getGitHubRepositoryInfos: function (accessToken) {
        return githubUtils.request(githubUtils.GITHUB_URLS.REPOS, accessToken);
    },

    /**
     * Adds a webhook to repository
     *
     * @param {string} pid - projectId
     * @param {string} accessToken An access token of GitHub
     * @see https://developer.github.com/v3/repos/hooks/#create-a-hook
     */
    addWebhook: function (pid, accessToken) {
        return dbLiteProject.$findOneAsync({
            pid: pid
        }).then(function (context) {
            var project = context.result();
            if (project) {
                var reposHookUrl = githubUtils.GITHUB_URLS.REPOS_HOOK_URL({url: project.name});
                var hostUrl = getJsaHostUrl();
                var webhookUrl = hostUrl + WEBHOOK_URL;
                var payload = {
                    'name': 'web',  //webhook service name 'web'
                    'active': true,
                    'events': ['push'],
                    'config': {
                        'url': webhookUrl,
                        'content_type': 'json',
                        'secret': process.env.SECRET_TOKEN
                    }
                }
                return githubUtils.request(reposHookUrl, accessToken, githubUtils.requestMethod.post, payload);
            } else {
                throw new JsaError('Requested project (' + pid + ') does not exist.', 404);
            }
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * Gets webhooks from repository
     *
     * @param {string} reposHookUrl - github repository hook url (/repo/:owner/:repo/hooks)
     * @param {string} accessToken An access token of GitHub
     * @return {array} webhook object array
     * @see https://developer.github.com/v3/repos/hooks/#list-hooks
     */
    getWebhooks: function (reposHookUrl, accessToken) {
        return githubUtils.request(reposHookUrl, accessToken);
    },

    /**
     * Removes webhook from repository
     *
     * @param {string} pid - projectId
     * @param {string} accessToken An access token of GitHub
     * @see https://developer.github.com/v3/repos/hooks/#delete-a-hook
     */
    removeWebhook: function (pid, accessToken) {
        var self = this;
        return dbLiteProject.$findOneAsync({
            pid: pid
        }).then(function (context) {
            var project = context.result();
            if (project) {
                var reposHookUrl = githubUtils.GITHUB_URLS.REPOS_HOOK_URL({url: project.name});
                return self.getWebhooks(reposHookUrl, accessToken).then(function (body) {
                    var hostUrl = getJsaHostUrl();
                    var webhookUrl = hostUrl + WEBHOOK_URL;
                    var length = body.length;
                    var hook;

                    for (var i = 0; i < length; i++) {
                        var hookUrl = body[i].config.url;
                        if (hookUrl === webhookUrl) {
                            hook = body[i];
                            break;
                        }
                    }

                    if (hook) {
                        reposHookUrl = reposHookUrl + '/' + hook.id;
                        return githubUtils.request(reposHookUrl, accessToken, githubUtils.requestMethod.delete);
                    } else {
                        return new JsaError('Can\'t find the webhook of deepscan: ' + webhookUrl);
                    }
                });
            } else {
                throw new JsaError('Requested project (' + pid + ') does not exist.', 404);
            }
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    getRemoteBranchInfos: function (userId, projectId) {
        return dbLiteProject.$findOneAsync({
            pid: projectId
        }).then(function (context) {
            var project = context.result();
            if (project) {
                return getFsid(userId).then(function (fsId) {
                    var jsaGit = new JsaGit(fsId, projectId);
                    return jsaGit.getRemoteListFromURL(project.url);
                });
            } else {
                throw new JsaError('Requested project (' + projectId + ') does not exist.', 404);
            }
        }).then(function (remotes) {
            return createRemoteBranchInfos(remotes);
        });
    },

    /**
     * 특정 브랜치의 결함 통계 정보 획득
     * @param {string} branchId - 대상 브랜치의 id
     * @param {object} option - 결함 검색 옵션
     */
    getStatisticsInfoOfBranch: function (branchId, option) {
        option.ownerBranchIds = [branchId];

        return createStatisticsInfo(branchId, option)
            .catch(function (error) {
                logger.error(error);
                throw new JsaError('Requested statistics of (' + branchId + ') does not exist.', 404);
            });
    },

    /**
     * 브랜치 생성
     *  분석을 위해 새로운 브랜치 객체 생성 및 branch 테이블 update
     * @param {string} projectId - 대상 project의 id
     * @param {string} branchName - 분석할 브랜치 명
     * @return {Promise} fulfill 시 생성된 branch id, reject 시 error 메시지를 전달
     */

    createBranch: function (projectId, branchInfo) {
        return dbLiteProject.$findOneAsync({pid: projectId})
            .bind({})
            .then(function (context) {
                var row = context.result();
                if (row) {
                    return dbLiteBranch.$saveAsync({
                        ownerPid: projectId,
                        name: branchInfo.name
                    });
                } else {
                    throw new JsaError('cannot find project ' + projectId);
                }
            }).then(function (context) {
                var row = context.result();
                if (row && row.insertId) {
                    return row.insertId;
                } else {
                    throw new JsaError('cannot save analysis');
                }
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 브랜치를 삭제
     * @param {string} uid - User ID
     * @param {string} pid - 프로젝트 ID
     * @param {string} bid - 브랜치 ID
     */
    deleteBranch: function (uid, pid, bid) {
        return dbLiteBranch.$removeAsync({
            bid: bid
        }).then(function (context) {
            return;
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * 프로젝트 하위의 모든 분석의 정보를 획득
     * @param {string} pid - 프로젝트 ID
     */
    getBranchInfos: function (pid) {
        return dbLiteBranch.$findAsync({
            ownerPid: pid
        }).then(function (context) {
            var rows = context.result();
            return Promise.map(rows, function (row) {
                return dbLiteBranch.getBranchWithLastAnalysisAsync({
                    bid: row.bid
                }).then(function (context) {
                    var rows = context.result();
                    return createLiteBranchInfoFromSQLRow(rows[0]);
                });
            });
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * 분석의 정보를 획득
     * @param {string} pid - 프로젝트 ID
     * @param {string} bid - 브랜치 ID
     */
    getBranchInfo: function (pid, bid) {
        return dbLiteBranch.getBranchWithLastAnalysisAsync({
            bid: bid
        }).then(function (context) {
            var rows = context.result();
            if (rows && rows[0]) {
                return createLiteBranchInfoFromSQLRow(rows[0]);
            } else {
                throw new JsaError('Requested branch (' + bid + ') does not exist.', 404);
            }
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * 특정 브랜치 정보 설정
     * @param {string} uid - User ID
     * @param {string} bid - 브랜치 ID
     * @param {object} branchInfo - 설정할 브랜치 정보
     */
    setBranchInfo: function (uid, bid, branchInfo) {
        return dbLiteBranch.$updateAsync({
            bid: bid,
            $set: branchInfo
        }).then(function (context) {
            return;
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },


    /**
     * 분석 생성
     *  분석 시작을 위해 새로운 analysis 객체를 생성 및 analysis DB update
     * @param {string} branchId - 대상 branch의 id
     * @return {Promise} fulfill 시 생성된 analysis의 객체, reject 시 error 메시지를 전달
     */
    createAnalysis: function (branchId) {
        return dbLiteBranch.$findOneAsync({bid: branchId})
            .bind({})
            .then(function (context) {
                var row = context.result();
                if (row) {
                    this.branch = row;
                    return dbLiteProject.$findOneAsync({pid: row.ownerPid});
                } else {
                    throw new JsaError('cannot find branch ' + branchId);
                }
            }).then(function (context) {
                var row = context.result();
                if (row) {
                    return getFsid(row.ownerUid);
                } else {
                    throw new JsaError('cannot find project ' + this.branch.ownerPid);
                }
            }).then(function (fsId) {
                logger.debug('[branch]', this.branch);
                logger.debug('[fsId]', fsId);
                this.fsId = fsId;
                var analysisInfo = {
                    ownerBid: branchId,
                    status: 'Pending'
                };
                return saveAnalysis(analysisInfo);
            }).then(function (aid) {
                var sourcePath = path.normalize(getSourcePath(this.fsId, aid));
                this.aid = aid;
                return updateAnalysisInfo(aid, {fsPath: sourcePath, path: sourcePath});
            }).then(function () {
                return this.aid;
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 분석을 삭제
     * @param {string} uid - User ID
     * @param {string} bid - 브랜치 ID
     * @param {string} aid - 분석 ID
     */
    deleteAnalysis: function (uid, bid, aid) {
        return dbLiteAnalysis.$removeAsync({
                aid: aid
            }).then(function (context) {
                return;
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 브랜치 하위의 모든 분석의 정보를 획득
     * @param {string} bid - 브랜치 ID
     */
    getAnalysisInfos: function (bid) {
        return dbLiteAnalysis.$findAsync({
                ownerBid: bid
            }).then(function (context) {
                var rows = context.result();
                return _.map(rows, function (row) {
                    return createLiteAnalysisInfoFromSQLRow(row);
                });
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 분석의 정보를 획득
     * @param {string} aid - 분석 ID
     */
    getAnalysisInfo: function (aid) {
        return dbLiteAnalysis.$findOneAsync({
                aid: aid
            }).then(function (context) {
                var row = context.result();
                if (row) {
                    return createLiteAnalysisInfoFromSQLRow(row);
                } else {
                    throw new JsaError('Requested analysis (' + aid + ') does not exist.', 404);
                }
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * @typedef DefectsInfo
     * @type {Object}
     * @property {number} totalCount The number of total defects
     * @property {array} defects An array of Defect
     */

    /**
     * Gets a DefectsInfo corresponding option.
     *
     * @return {Promise} - a promise that is resolved a DefectsInfo
     */
    getDefectsInfoByOption: function (option) {
        var defectsInfo = {
            totalCount: 0
        };
        return dbLiteDefect.getDefectsCountAsync(option)
            .then(function (context) {
                var rows = context.result();
                if (rows && rows.length === 1) {
                    defectsInfo.totalCount = rows[0].count;
                }

                if (defectsInfo.totalCount === 0) {
                    return defectsInfo;
                } else {
                    return dbLiteDefect.getDefectsAsync(option)
                        .then(function (context) {
                            var rows = context.result();

                            defectsInfo.defects = _.map(rows, function (row) {
                                return createLiteDefectInfoFromSQLRow(row);
                            });
                            return defectsInfo;
                        });
                }
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 사용자가 가진 프로젝트들에서 모든 결함 정보를 획득
     * @param {string} uid - User ID
     * @param {object} option - 결함 검색 옵션
     */
    getDefectsInfoOfUser: function (uid, option) {
        /*
        return this.getProjectInfos(uid)
            .bind(this)
            .then(function (projects) {
                option.ownerProjectIds = _.map(projects, 'id');

                return this.getDefectsInfoByOption(option);
            });
        */
    },
    /**
     * 모든 프로젝트에서 owner에 해당하는 모든 결함 정보를 획득
     * @param {string} owner - User email
     * @param {object} option - 결함 검색 옵션
     */
    getDefectsInfoOfOwner: function (owner, option) {
        /*
        option.owners = [owner];

        return this.getDefectsInfoByOption(option);
        */
    },
    /**
     * 하나의 브랜치에서 모든 결함 정보를 획득
     * @param {string} bid - 브랜치 ID
     * @param {object} option - 결함 검색 옵션
     */
    getDefectsInfoOfBranch: function (bid, option) {
        option.ownerBranchIds = [bid];

        return this.getDefectsInfoByOption(option);
    },

    /**
     * 하나의 브랜치에서 하나의 결함 정보를 획득
     * @param {string} bid - 브랜치 ID
     * @param {string} did - 결함 ID
     */
    getDefectInfoOfBranch: function (bid, did) {
        var option = {};
        option.ownerBranchIds = [bid];
        option.ids = [did];

        return this.getDefectsInfoByOption(option)
            .then(function (defectsInfo) {
                return defectsInfo.defects[0];
            });
    },

    /**
     * 특정 결함의 정보 설정
     * @param {string} uid - User ID
     * @param {string} bid - 브랜치 ID
     * @param {string} did - 결함 ID
     * @param {object} defectInfo - 설정할 결함 정보
     */
    setDefectInfo: function (uid, bid, did, defectInfo) {
        var updateInfo = createUpdateInfoAboutDefect(defectInfo);

        return dbLiteDefect.$updateAsync({
            did: did,
            $set: updateInfo
        }).then(function (context) {
            return;
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * 여러 결함의 정보 설정
     * @param {string} uid - User ID
     * @param {string} bid - 브랜치 ID
     * @param {array|object} defectInfo - 설정할 결함 정보
     * @param {string} defectInfo.id An id of defect.
     * @param {string} defectInfo.classification A classification of defect.
     * @param {string} defectInfo.action An action of defect.
     * @param {string} defectInfo.owner An owner of defect.
     */
    setDefectInfos: function (uid, bid, defectInfos) {
        var tasks = _.map(defectInfos, function (defectInfo) {
            var updateInfo = createUpdateInfoAboutDefect(defectInfo);

            return dbLiteDefect.$update({
                did: defectInfo.id,
                $set: updateInfo
            });
        });

        return dbManager.transactionAsync(tasks)
            .then(function (context) {
                return;
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * 페이지 하위의 모든 알람의 정보를 획득
     * @param {string} uid - User ID
     * @param {string} pid - 프로젝트 ID
     * @param {string} aid - 분석 ID
     * @param {string} pageId - 페이지 ID
     */
    getAlarmInfos: function (uid, pid, aid, pageId) {
        /*
        return dbAlarm.getAlarmsAsync({
            ownerPageId: pageId
        }).then(function (context) {
            var rows = context.result();
            return _.map(rows, function (row) {
                return createAlarmInfoFromSQLRow(row);
            });
        }).catch(function (error) {
            throw new JsaError(error);
        });
        */
    },

    /**
     * 결함의 정보를 획득
     * @param {string} uid - User ID
     * @param {string} pid - 프로젝트 ID
     * @param {string} aid - 분석 ID
     * @param {string} pageId - 페이지 ID
     * @param {string} alarmId - 알람 ID
     */
    getAlarmInfo: function (uid, pid, aid, pageId, alarmId) {
        /*
        return dbAlarm.$findOneAsync({
            alarmId: alarmId
        }).then(function (context) {
            var row = context.result();
            if (row) {
                return createAlarmInfoFromSQLRow(row);
            } else {
                throw new JsaError('Requested alarm (' + alarmId + ') does not exist.', 404);
            }
        }).catch(function (error) {
            throw new JsaError(error);
        });
        */
    },

    /**
     * 분석 시작
     *  branchId 이용해 analysis 생성
     *  analyzer의 start 호출
     *  analysis id 리턴
     * @param {string} branchId - 브랜치 ID
     * @param {string|undefined} commitId - 특정 commit ID
     */
    startAnalysis: function (branchId, commitId) {
        var self = this;
        return self.createAnalysis(branchId).then(function (aid) {
            // 이전 분석이 종료 된 후 다음 분석을 하도록 interval 설정
            var startInterval = setInterval(function () {
                getInprogressAnalysesOfBranch(branchId).then(function (analyses) {
                    var isFirstAid =  _.min(_.pluck(analyses, 'aid')) === aid;
                    if (isFirstAid) {
                        clearInterval(startInterval);
                        analyzer.start(aid, commitId);
                    }
                })
            }, 5000);
            return aid;
        }).catch(function (err) {
            throw new JsaError(err);
        });
    },

    /**
     * 진행중 또는 대기중인 분석을 중단
     * analyzer의 stop 호출
     * @param {string} branchId - 브랜치 ID
     */
    stopAnalysis: function (branchId) {
        return getInprogressAnalysesOfBranch(branchId)
            .then(function (analyses) {
                if (analyses) {
                    return Promise.map(analyses, function (analysis) {
                        return analyzer.stop(analysis.aid);
                    });
                } else {
                   throw new JsaError('Requested branch (' + branchId + ') is not of analysis');
                }
            });
    },

    /**
     * 브랜치의 분석 상태를 획득
     *  analyzer의 getStatus 호출
     * @param {string} aid - 상태를 알고싶은 분석 ID
     * 분석 상태 문자열 - 'analyzing': 분석 중
     *                  'success': 분석 성공
     *                  'fail': 분석 실패
     *                  'pending': 분석 대기 중
     */
    getStatus: function (aid) {
        return analyzer.getStatus(aid);
    },

    /**
     * project option 객체 획득
     * @param {string} pid - 프로젝트 ID
     */
    getProjectSettings: function (pid) {
        return dbLiteProjectSettings.$findOneAsync({
                ownerPid: pid
            }).then(function (context) {
                var row = context.result();
                if (row) {
                    return createLiteProjectSettingsInfoFromSQLRow(row);
                } else {
                    throw new JsaError('Requested project option of (' + pid + ') does not exist.', 404);
                }
            }).catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * project settings 객체 저장
     * @param {string} pid - 프로젝트 ID
     * @param {object} project settings - 저장하려는 project settings 객체 {watching, notificationEmail, ignoreFiles}
     */
    setProjectSettings: function (pid, settings) {
        if (settings.hasOwnProperty('notificationEmails')) {
            settings.notificationEmails = JSON.stringify(settings.notificationEmails);
        }
        if (settings.hasOwnProperty('ignoreFiles')) {
            settings.ignoreFiles = JSON.stringify(settings.ignoreFiles);
        }

        return dbLiteProjectSettings.$updateAsync({
            ownerPid: pid,
            $set: settings
        }).then(function (context) {
            return;
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * 특정 프로젝트의 룰 객체 배열 획득
     * @param {string} pid - 프로젝트 ID
     */
    getProjectRules: function (pid) {
        return dbLiteRule.getDefaultRulesAsync().then(function (context) {
            var defaultRules = context.result();
            return dbLiteRule.getRulesAsync({
                ownerPid: pid
            }).then(function (context2) {
                var rows = context2.result();
                var rules = _.map(rows, function (row) {
                    var rule = createLiteRuleInfoFromSQLRow(row);

                    rule.deprecated = !_.find(defaultRules, {
                        name: rule.name
                    });

                    return rule;
                });

                return rules;
            });
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * 특정 프로젝트의 룰의 정보 설정
     * @param {string} ruleId - 룰 ID
     * @param {object} ruleInfo - 설정할 룰 정보
     */
    setProjectRule: function (projectId, ruleId, ruleInfo) {
        var tasks = [];

        if (ruleInfo.hasOwnProperty('impacts')) {
            ruleInfo.impacts = JSON.stringify(ruleInfo.impacts);
        }
        if (ruleInfo.hasOwnProperty('cwes')) {
            ruleInfo.cwes = JSON.stringify(ruleInfo.cwes);
        }
        if (ruleInfo.hasOwnerProperty('enabled')) {
            // update rule_excluded_by_settings of Defect
            tasks.push(function (context, next) {
                dbLiteDefect.updateRuleExcludedOfNonExcludedDefectsByRuleId({
                    excluded: ruleInfo.enabled ? 0 : 1,
                    ownerPid: projectId,
                    ruleId: ruleId
                }, next, context);
            });
        }

        tasks.push(function (context, next) {
            dbLiteRule.$update({
                id: ruleId,
                $set: ruleInfo
            }, next, context);
        });

        return dbManager.transactionAsync(tasks).then(function (context) {
            return;
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * 특정 프로젝트의 룰의 정보 설정
     * @param {object} ruleInfos - 설정할 룰 정보
     */
    setProjectRules: function (projectId, ruleInfos) {
        var tasks = [];
        _.each(ruleInfos, function (value, key) {
            if (value.hasOwnProperty('impacts')) {
                value.impacts = JSON.stringify(value.impacts);
            }
            if (value.hasOwnProperty('cwes')) {
                value.cwes = JSON.stringify(value.cwes);
            }
            if (value.hasOwnProperty('enabled')) {
                // update rule_excluded_by_settings of Defect
                tasks.push(function (context, next) {
                    dbLiteDefect.updateRuleExcludedOfNonExcludedDefectsByRuleId({
                        excluded: value.enabled ? 0 : 1,
                        ownerPid: projectId,
                        ruleId: key
                    }, next, context);
                });
            }

            tasks.push(function (context, next) {
                dbLiteRule.$update({
                    id: key,
                    $set: value
                }, next, context);
            });
        });

        return dbManager.transactionAsync(tasks).then(function (context) {
            return;
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },

    /**
     * Gets a jsa information.
     *
     @returns {object} Promise resolves a jsa information, rejects JsaError object.
     */
    getJsaInfo: function () {
        var jsaInfo = {};
        return analyzer.getEngineInfo()
            .then(function (engineInfo) {
                // TODO : JSA에 대한 정보 추가
                jsaInfo.engineInfo = engineInfo;
                return jsaInfo;
            })
            .catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * @typedef UserInfo
     * @type {Object}
     * @property {string} email A user email
     * @property {string} name A user name
     */

    /**
     * Gets an array containing UserInfo.
     *
     * @return {Promise} - a promise that is resolved an array of UserInfos
     */
    getUsers: function () {
        var getUsers = Promise.promisify(userdb.getUsers);
        return getUsers()
            .catch(function (error) {
                throw new JsaError(error);
            });
    },

    /**
     * Gets GitHub user information.
     *
     * @param {string} accessToken An access token of GitHub
     * @return {Promise} - a promise that is resolved with GitHub user information. Please see https://developer.github.com/v3/users/#get-the-authenticated-user for details.
     */
    getGitHubUserInfo: function (accessToken) {
        return githubUtils.request(githubUtils.GITHUB_URLS.USER, accessToken);
    },


    /**
    * git url과 branch name을 받아 자동 분석을 실행
    * @param {string} gitUrl - git url
    * @param {string} branch -  branch name
    * @param {string|undefined} commitId - 특정 commit ID
    */
    autoAnalysis: function (gitUrl, branch, commitId) {
        var self = this;
        return dbLiteProject.$findAsync({
            url: gitUrl
        }).then(function (context) {
            var projects = context.result();
            // 공유 프로젝트의 경우, 동일 url로 여러 프로젝트가 생성될 수 있기 때문에
            // 각각의 프로젝트에 대해 처리하기 위해 map을 사용함.
            return Promise.map(projects, function (project) {
                return dbLiteBranch.$findAsync({
                    ownerPid: project.pid,
                    name: branch
                }).then(function (context) {
                    var rows = context.result();
                    return _.map(rows, function (row) {
                        return row.bid;
                    });
                }).then(function (bids) {
                    // 프로젝트 내에 branch name이 없는 경우 branchId 값이
                    // empty 값이 되므로 flatten을 사용하여 걸러냄.
                    bids = _.flatten(bids);
                    return Promise.map(bids, function (bid) {
                        return self.startAnalysis(bid, commitId);
                    });
                });
            });
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },
    
    /**
    * barnchId를 받아 badge svg 파일의 경로를 반환
    * @param {string} branchId -  branch id
    */
    getBadgePath: function (branchId) {
        var param = {
            ownerBid: branchId
        };
        return dbLiteAnalysis.getLastAnalysisAsync(param)
            .then(function (context) {
                var rows = context.result();
                var analysis = rows[0];
                var badgePath = analysis.fsPath + path.join('/', 'badge', 'grade.svg');
                return badgePath;
        }).catch(function (error) {
            throw new JsaError(error);
        });
    },
    
    /**
    * pid와 bid를 받아 html badge와 md badge를 생성하여 반환
    * @param {string} pid - projectId
    * @param {string} bid - branchId
    * @return {objet} badges - html, md 두가지의 badge를 가지고 있는 객체를 반환
    */
    getBadgeData: function (pid, bid) {
        return new Promise(function (resolve, reject) {
            var badges = {};
            var badgeUrl = conf.jsaHostUrl + path.join('/', 'api', 'projects', pid, 'branches', bid, 'badge', 'grade.svg');
            var linkUrl = conf.appHostUrl + '/lite/index.html#view=project&pid=' + pid + '&bid=' + bid + '&subview=overview"';
            var alt = 'Deepscan grade';

            var imgStr = '<img src="' + badgeUrl + '" alt="Deepscan grade">' ;
            var anchorStr = '<a href="' + linkUrl + '>';
            var htmlBadge = anchorStr + imgStr + '</a>';
            badges.html = htmlBadge;

            var mdBadge = '[![' + alt + '](' + badgeUrl +')] (' + linkUrl + ')';
            badges.md = mdBadge;

            resolve(badges);
        }).catch(function (error) {
            throw new JsaError(error);
        });
    }
};

/**
 * analysis DB에 새로운 analysis를 생성
 * @param {object} analysisInfo - ownerPid, url을 가지는 객체
 * @return {object} promise - 성공 시 생성된 analysis의 id, 실패 시 error 메시지를 전달
 */
function saveAnalysis(analysisInfo) {
    return dbLiteAnalysis.$saveAsync(analysisInfo)
        .then(function (context) {
            var row = context.result();
            if (row && row.insertId) {
                return row.insertId;
            } else {
                throw new JsaError('cannot save analysis');
            }
        }).catch(function (error) {
            throw new JsaError(error);
        });
}

/**
 * analysis DB를 update
 * @param {string} analysis id
 * @param {object} updateInfo - analysis를 update할 정보를 가지는 객체
 * @return {object} promise - 성공 시 DB update 성공 객체, 실패 시 error 메시지를 전달
 */
function updateAnalysisInfo(analysisId, updateInfo) {
    return dbLiteAnalysis.$updateAsync({
        aid: analysisId,
        $set: updateInfo
    }).then(function (context) {
        return context.result();
    }).catch(function (error) {
        throw new JsaError(error);
    });
}

/**
 * 터널링 사용시 환경변수 TUNNELING_JSA_HOST에 터널링 주소를 적어 주면
 * 해당 환경변수를 jsaHostUrl로 사용
 * GitHub의 webhook을 사용하기 위해 구현
 *
 * @return {string}터널링 주소 또는 jsaHostUrl
 */
function getJsaHostUrl() {
    if (process.env.TUNNELING_JSA_HOST) {
        return process.env.TUNNELING_JSA_HOST;
    }
    return conf.jsaHostUrl;
}

module.exports = jsaManager;
