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
var _ = require('lodash');
var fs = require('fs-extra');
var path = require('path');
var Promise = require('bluebird');
var badge = require('gh-badges');  //github badges

// webida modules
var conf = require('../../../common/conf-manager').conf;
var fsMgr = require('../../../fs/lib/fs-manager');
var logger = require('../../../common/logger-factory').getLogger('ANALYZER');

// jsa modules
var constants = require('./constants');
var engineMgr = require('./engine-manager');
var hDefectMerger = require('./historical-defect-merger');
var JsaGit = require('./jsa-git');
var jsaReporter = require('./jsa-reporter');

var defectExcluder = require('../common/defect-excluder');
var jsaDao = require('../common/jsa-dao');
var JsaError = require('../common/jsa-error');

var dbLiteProject = jsaDao.dbLiteProject;
var dbLiteProjectSettings = jsaDao.dbLiteProjectSettings;
var dbLiteBranch = jsaDao.dbLiteBranch;
var dbLiteDefect = jsaDao.dbLiteDefect;
var dbLiteAnalysis = jsaDao.dbLiteAnalysis;
var dbLiteAlarm = jsaDao.dbLiteAlarm;
var dbLiteRule = jsaDao.dbLiteRule;

var engineIdMap = {};


//Grade
var gradeComputer = {
    // name : grade label
    // thresholdHighMedium : value of high medium impact threshold
    // thresholdLow : value of low impact threshold value
    level : {
        poor : { name: constants.LITE_GRADE_POOR, thresholdHighMedium: '1', thresholdLow: '10'},
        normal : { name: constants.LITE_GRADE_NORMAL, thresholdHighMedium: '1', thresholdLow: '10'},
        good : { name: constants.LITE_GRADE_GOOD, thresholdHighMedium: '1', thresholdLow: '5'}
    },

    _density: function (count, loc) {
        if (count) {
            return (count / loc) * 1000;
        } else {
            return 0;
        }
    },

    // impact 종류별 카운팅: High, Medium, Low, Others
    _getImpactCount: function (defects) {
        return _.countBy(defects, function (defect) {
            if (defect.impact == constants.DEFECT_IMPACTS[0]) {
                return constants.DEFECT_IMPACTS[0];
            } else if (defect.impact == constants.DEFECT_IMPACTS[1]) {
                return constants.DEFECT_IMPACTS[1];
            } else if (defect.impact == constants.DEFECT_IMPACTS[2]) {
                return constants.DEFECT_IMPACTS[2];
            } else {
                return 'Others';
            }
        });
    },

    compute: function (defects, loc) {
        // 분석된 내용이 없으면 empty string을 반환
        if (!loc) {
            logger.debug('LOC is zero');
            return '';
        }

        var grade = '';
        var impactCount = this._getImpactCount(defects);

        var highDensity = this._density(impactCount.High, loc);
        var mediumDensity = this._density(impactCount.Medium, loc);
        var lowDensity = this._density(impactCount.Low, loc);

        if (highDensity >= this.level.poor.thresholdHighMedium || mediumDensity >= this.level.poor.thresholdHighMedium || lowDensity >= this.level.poor.thresholdLow) {
            grade = this.level.poor.name;
        }else {
            if (lowDensity < this.level.good.thresholdLow) {
                grade = this.level.good.name;
            } else if (lowDensity < this.level.normal.thresholdLow) {
                grade = this.level.normal.name;
            }
        }

        logger.debug('lines of code: ', loc);
        logger.debug('density - high: ', highDensity, '    medium: ', mediumDensity, '    low: ', lowDensity);
        logger.debug('Computed grade: ', grade);

        return grade;
    }
};

function setAnalysisWorkspaceSettings(destPath) {
    var srcPath = path.normalize(path.join(__dirname, './template/analysis-workspace-template/'));
    fs.copy(srcPath, destPath, {
        clobber: true
    }, function (error) {
        if (error) {
            logger.error(error);
        }
    });
}

/**
 * analysis 객체를 획득
 *  analysis DB로부터 analysis id를 이용하여 analysis 객체를 얻어옴
 *
 * @param {string} analysis id
 * @return {object} promise - 성공 시 analysis 객체, 실패 시 error 메시지를 전달
 */
function findAnalysis(analysisId) {
    return dbLiteAnalysis.$findOneAsync({
        aid: analysisId
    }).then(function (context) {
        var row = context.result();
        if (row) {
            return row;
        } else {
            throw new JsaError('Requested analysis (' + analysisId + ') does not exist.', 404);
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
    if (updateInfo.hasOwnProperty('files')) {
        updateInfo.files = JSON.stringify(updateInfo.files);
    }
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
 * disabled된 rule name 배열을 획득
 *  rule DB로부터 pid를 이용하여 rule name 배열을 얻어옴
 *
 * @param {string} pid 프로젝트 ID
 * @return {object} promise - 성공 시 rule name 배열, 실패 시 error 메시지를 전달
 */
function getDisabledRuleNames(pid) {
    return dbLiteRule.getDisabledRuleNamesAsync({
        ownerPid: pid
    }).then(function (context) {
        var rows = context.result();
        return _.compact(_.map(rows, function (row) {
            return row.name;
        }));
    }).catch(function (error) {
        throw new JsaError(error);
    });
}

/**
 * enabled된 rule name 배열을 획득
 *  rule DB로부터 pid를 이용하여 rule name 배열을 얻어옴
 *
 * @param {string} pid 프로젝트 ID
 * @return {object} promise - 성공 시 rule name 배열, 실패 시 error 메시지를 전달
 */
function getEnabledRuleNames(pid) {
    return dbLiteRule.getEnabledRuleNamesAsync({
        ownerPid: pid
    }).then(function (context) {
        var rows = context.result();
        return _.compact(_.map(rows, function (row) {
            return row.name;
        }));
    }).catch(function (error) {
        throw new JsaError(error);
    });
}

/**
 * 분석에 필요한 옵션들 정보 획득
 *  1. Rule 제외 정보
 *  2. 결함 파일 제외 정보
 *
 * @param {object} analysis - analysis 객체
 * @return {object} promise - 성공 시 분석 객체 및 옵션 정보를 담은 analysisInfo 객체, 실패 시 error 메시지를 전달
 */
function getOptions(analysis) {
    logger.debug('get project options of analysis' + analysis.aid);
    var projectId = analysis.ownerPid;
    var analysisInfo = {
        analysis: analysis,
        options: {}
    };

    // get projectId
    return dbLiteBranch.$findOneAsync({
        bid: analysis.ownerBid
    }).then(function (context) {
        var branch = context.result();
        analysisInfo.projectId = branch.ownerPid;
        return dbLiteProjectSettings.$findOneAsync({
            ownerPid: analysisInfo.projectId
        });
    }).then(function (context) {
        var projectSettings = context.result();
        if (projectSettings.ignoreFiles) {
            projectSettings.ignoreFiles = JSON.parse(projectSettings.ignoreFiles);
        }
        analysisInfo.options.projectSettings = projectSettings;
        return analysisInfo.projectId;
    })
    .then(getDisabledRuleNames)
    .then(function (disabledRuleNames) {
        analysisInfo.options.disabledRuleNames = disabledRuleNames;
        return analysisInfo.projectId;
    })
    .then(getEnabledRuleNames)
    .then(function (enabledRuleNames) {
        analysisInfo.options.enabledRuleNames = enabledRuleNames;
        return analysisInfo;
    }).catch(function (err) {
        logger.error('Cannot get project option of ' + analysis.aid);
        throw new JsaError(err);
    });
}

function findProject(branch) {
    var projectId = branch.ownerPid;
    return dbLiteProject.$findOneAsync({
        pid: projectId
    }).then(function (context) {
        var row = context.result();
        if (row) {
            return row;
        } else {
            throw new JsaError('Cannot find project of ' + branch.bid);
        }
    }).catch(function (err) {
        logger.error('Cannot get project of ' + projectId);
        throw new JsaError(err);
    });
}

/**
 * Git 소스를 clone 또는 pull
 * project object의 fsid와 pid를 이용하여 JsaGit을 생성.
 * JsaGit의 clone() 또는 pull() 호출
 * git 명령이 실패하면 분석 실패
 * @param {object} project object
 */
function fetchGitSource(branch, analysisInfo) {
    var getFsinfo = Promise.promisify(fsMgr.getFsinfosByUid);
    var analysis = analysisInfo.analysis;
    var commitId = analysisInfo.commitId;
    var jsaGit;
    var project;

    function updateGitRepo() {
        logger.debug('update git : ', project.url, branch.name);
        // git checkout & pull
        return jsaGit.checkout(branch.name)
            .bind(jsaGit)
            .then(jsaGit.pull);
    }

    function cloneGitRepo() {
        logger.debug('colne git : ', project.url, branch.name);
        return jsaGit.clone(project.url, branch.name);
    }

    function checkoutGitRepo() {
        logger.debug('checkout git : ', commitId);
        return jsaGit.checkout(commitId);
    }

    function removeAndCloneGitRepo() {
        // remove git repo & clone
        return jsaGit.removeGitRepo()
            .then(cloneGitRepo);
    }

    return findProject(branch)
        .then(function (prj) {
            project = prj;
            return project.ownerUid;
        }).then(getFsinfo)
        .then(function (result) {
            return result[0].wfsId;
        })
        .then(function (fsid) {
            jsaGit = new JsaGit(fsid, analysis.aid);
            return jsaGit.isGitRepo();
        })
        .then(function (isGitRepo) {
            if (isGitRepo) {
                return updateGitRepo();
            } else {
                if (commitId) {
                    return cloneGitRepo().then(checkoutGitRepo);
                } else {
                    return cloneGitRepo();
                }
            }
        })
        .then(function () {
            return jsaGit;
        })
        .catch(function (error) {
            throw new JsaError(error);
        });
}

/**
 * analysis 의 source를 다운로드
 *  analysis의 ownerPid를 통해 project 객체를 얻어옴
 *  project 객체의 sourceType이 Web이면 crawlSource, Git이면 git clone/pull 함
 *
 * @param {object} analysisInfo - 분석 객체 및 분석 옵션 정보를 담은 객체
 * @return {object} promise - 성공 시 analysis 객체, 실패 시 error 메시지를 전달
 */
function fetchSource(analysisInfo) {
    logger.debug('fetch source of analysis ' + analysisInfo.analysis.aid);
    var branchId = analysisInfo.analysis.ownerBid;
    var targetPath = analysisInfo.analysis.fsPath;

    return dbLiteBranch.$findOneAsync({
        bid: branchId
    }).then(function (context) {
        var row = context.result();
        if (row) {
            return row;
        } else {
            throw new JsaError('Cannot find branch ' + branchId);
        }
    }).then(function (branch) {
        // fetchGitSource() 실행
        return fetchGitSource(branch, analysisInfo)
            .then(function (jsaGit) {
                return jsaGit.getCommitId()
                    .then(function (commitId) {
                        logger.debug('[git commitId]', commitId);
                        analysisInfo.analysis.gitCommitId = commitId;
                        return jsaGit.getCommitAuthorName();
                    }).then(function(authorName) {
                        logger.debug('[git authorName]', authorName);
                        analysisInfo.analysis.authorName = authorName;
                        return;
                    });
            }).then(function () {
                return updateAnalysisInfo(analysisInfo.analysis.aid, {gitCommitId: analysisInfo.analysis.gitCommitId});
            });
    }).then(function () {
        return analysisInfo;
    }).catch(function (error) {
        //소스 다운로드 실패시 analysis DB에 분석 실패 기록
        var updateInfo = {
            startTime: Date.now(),
            endTime: Date.now(),
            status: constants.LITE_STATUS_FAIL
        };
        logger.error('fetchSource fail : ', error);
        return updateAnalysisInfo(analysisInfo.analysis.aid, updateInfo);
    });
}

/**
 * 모든 defect를 받아 new, triaged를 가려낸 후, impact의 수와 loc의 비율에 따라 등급을 계산
 * @param {array} allDefects - 모든 defects
 * @param {object} analysis - analysis info
 */
function getGrade(allDefects, analysis) {
    var defects = _.filter(allDefects, function (defect) {
        return defect.status === constants.LITE_DEFECT_STATUS_NEW || defect.status === constants.LITE_DEFECT_STATUS_TRIAGED;
    });

    // get LOC
    var fileSizeArr = _.map(analysis.files, function (file) { return parseInt(file.loc); });
    var loc = _.reduce(fileSizeArr, function (memo, size) { return (memo + size); }, 0);
    return gradeComputer.compute(defects, loc);
}

/**
* analysis의 grade를 읽어 grade.svg를 생성 및 /badge directory에 저장.
* @param {object} analysis - analysis info
*/
function createBadge(analysis) {
    var fsPath = analysis.fsPath;
    // bade example: [Deepscan|Good]
    return getBadgeSvg('Deepscan', analysis.grade).then(function (svg) {
        var filePath = fsPath + path.join('/', 'badge', 'grade.svg');
        return new Promise(function (resolve, reject) {
            // badge 폴더와 grade.svg파일을 생성
            fs.outputFile(filePath, svg, function (err) {
                if (err) {
                    logger.debug('Badge creation failed: ', filePath);
                    reject(err);
                } else {
                    logger.debug('Badge was created: ', filePath);
                    resolve();
                }
            });
        });
    });
}

/**
* grade값을 적용한 badge string을 반환
* @param {string} title - badge의 왼쪽 문자열
* @param {string} value - badge의 오른쪽 문자열
*/
function getBadgeSvg(title, value) {
    return new Promise(function (resolve, reject) {
        // badge format reference: "https://github.com/badges/shields/blob/master/INSTALL.md#format"
        var badgeFormat = { text: [ title, value ], colorscheme: "green", template: "flat" };
        badge(badgeFormat, function(svg, err) {
            if (err) {
                reject('Create badge failed: '. err);
            } else {
                logger.debug(' badge svg: ', svg);
                resolve(svg);
            }
        });
    });
}

function updateDefectsAfterMerging(defects) {
    return Promise.map(defects, function (defect) {
        if (!defect.did) {
            // new Defect
            return dbLiteDefect.$saveAsync(defect)
                .then(function (context) {
                    var row = context.result();
                    var did = row.insertId;
                    // alarm의 owner_did 업데이트
                    return Promise.map(defect.alarmIds, function (alarmId) {
                        return dbLiteAlarm.$updateAsync({
                            alarmId: alarmId,
                            $set: {
                                ownerDid: did
                            }
                        });
                    });
                });
        } else {
            // prev Defect
            return dbLiteDefect.$updateAsync({
                did: defect.did,
                $set: defect
            }).then(function () {
                if (defect.alarmIds) {
                    // alarm의 owner_did 업데이트
                    return Promise.map(defect.alarmIds, function (alarmId) {
                        return dbLiteAlarm.$updateAsync({
                            alarmId: alarmId,
                            $set: {
                                ownerDid: defect.did
                            }
                        });
                    });
                } else {
                    return null;
                }
            });
        }
    });
}


/**
 * 분석 시작 함수
 */
function startEngine(analysisInfo) {
    logger.debug('start engine of analysis' + analysisInfo.analysis.aid);

    var analysis = analysisInfo.analysis;
    var projectSettings = analysisInfo.options.projectSettings;
    var excludePatterns = projectSettings.rulePatternToExcludeFiles;
    var notificationEmails = projectSettings.notificationEmails ? projectSettings.notificationEmails.split(/[\s]+/) : null;

    var engineOptions = {};
    engineOptions[engineMgr.Options.RULES] = analysisInfo.options.enabledRuleNames;
    engineOptions[engineMgr.Options.BROWSERS] = projectSettings.browserCompats;


    engineIdMap[analysis.aid] = engineMgr.start(analysis.fsPath, engineOptions, function (status) {
        // lite 분석 시작 콜백
        logger.debug('start analyzing ' + analysis.aid);
        updateAnalysisInfo(analysis.aid, {status: status});
    }, function (err, engineResult) {
        // 분석 종료 콜백
        var alarms = null;
        var updateInfo = {
            startTime: engineResult ? engineResult.startTime : Date.now(),
            endTime: Date.now(),
            status: engineResult ? engineResult.status : constants.LITE_STATUS_FAIL,
            files: engineResult ? engineResult.files : []
        };
        if (err) {
            // FAIL, TIMEOUT, STOP, ERROR
            logger.warn(err, '[Analysis of ' + analysis.aid + ' fail!]');
        } else {
            // SUCCESS
            logger.debug('[Analysis of ' + analysis.aid + ' success!]');
            logger.debug('[analyzed files]', engineResult.files);
            alarms = _.map(engineResult.alarms, function (engineAlarm) {
                var absolutePath = path.normalize(path.join(engineResult.path, engineAlarm.filePath));
                var fsPath = path.relative(analysis.fsPath, absolutePath);
                var alarm = {};
                alarm.ownerAid = analysis.aid;
                alarm.impact = engineAlarm.impact;
                alarm.name = engineAlarm.name;
                alarm.message = engineAlarm.message;
                alarm.fsPath = fsPath;
                alarm.path = decodeURIComponent(fsPath);
                alarm.location = engineAlarm.location;
                alarm.codeFragment = engineAlarm.codeFragment;
                alarm.codeFragmentLocation = JSON.stringify(engineAlarm.codeFragmentLocation);
                return alarm;
            });
            analysis.status = engineResult.status;
            analysis.files = engineResult.files;
        }

        return updateAnalysisInfo(analysis.aid, updateInfo)
            .then(function () {
                // 분석 성공 시
                if (engineResult.status === constants.LITE_STATUS_SUCCESS) {
                    logger.debug('[newly detected alarms size]', alarms.length);

                    // 1. DB alarm 추가
                    return Promise.map(alarms, function (alarm) {
                        return dbLiteAlarm.$saveAsync(alarm)
                            .then(function (context) {
                                var row = context.result();
                                alarm.alarmId = row.insertId;
                                return alarm;
                            });
                    })

                    // 2. 검출된 alarms 와 기존 defects 머지
                    .then(function (alarms) {
                        logger.debug('save successfully for alarms of analysis ' + analysis.aid);
                        return hDefectMerger.mergeAlarms(analysis, alarms)
                            .then(function (defects) {
                                logger.debug('[total merged defects size]', defects.length);

                                // excluded 업데이트
                                var noRuleNames = analysisInfo.options.disabledRuleNames;
                                defects = defectExcluder.exclude(defects, noRuleNames, excludePatterns);

                                // 최종 defects DB에 업데이트
                                return updateDefectsAfterMerging(defects)
                                    .then(function () {
                                    // grade 계산 및 badge 생성
                                        analysis.grade = getGrade(defects, analysis);
                                        return createBadge(analysis);
                                    });
                            });
                    })

                    // 3. analysis에 Defect count 업데이트 및 엔진 Id 삭제
                    .then(function () {
                        logger.debug('update successfully for defects of analysis ' + analysis.aid);
                        delete engineIdMap[analysis.aid];

                        return hDefectMerger.getBranchDefects(analysis.ownerBid).then(function (defects) {
                            var noExcludedDefects = _.filter(defects, function (defect) {
                                return defect.status !== constants.LITE_DEFECT_STATUS_EXCLUDED;
                            });
                            var outstandingDefects = _.filter(noExcludedDefects, function (defect) {
                                return defect.status === constants.LITE_DEFECT_STATUS_NEW || defect.status === constants.LITE_DEFECT_STATUS_TRIAGED;
                            });

                            var updateInfo = {
                                totalDefectCount: noExcludedDefects.length,
                                outstandingDefectCount: outstandingDefects.length,
                                grade: analysis.grade
                            };
                            return updateAnalysisInfo(analysis.aid, updateInfo)
                                .then(function () {
                                    return outstandingDefects;
                                });
                            });
                    })

                    // 4. 분석 성공 메일 전송
                    .then(function (outstandingDefects) {
                        logger.debug('[notificationEmails]', notificationEmails);
                        jsaReporter.sendDefectsReport(null, analysis, outstandingDefects, notificationEmails);
                        return Promise.resolve();
                    });
                } else {
                    // 분석 실패
                    var err = 'Analysis is failed.';
                    return Promise.reject(err);
                }
            });
    });
}

var analyzer = {
    /**
     * 분석 시작
     *  analysisId를 통해 analysis 객체를 얻어옴
     *  소스 크롤링
     *  engineMgr의 start 호출 및 프로젝트가 가지는 engineIdMap필드로 분석중인 객체 리스트를 관리
     *
     * @param {string} aid - 분석 ID
     * @param {string|undefined} commitId - 특정 commit ID
     */
    start: function (aid, commitId) {
        logger.debug('start analysis: ', aid);
        return findAnalysis(aid)
            .then(getOptions)
            .then(function (analysisInfo) {
                analysisInfo.commitId = commitId;
                return analysisInfo;
            })
            .then(fetchSource)
            .then(startEngine);
    },

    /**
     * 특정 분석 다시 시작
     *  1. 크롤링이 완료되지 않은 분석이라면 다시 크롤링 후 분석
     *  2. 크롤링이 완료어 분석중이었던 분석이라면 페이지 리셋 후 분석
     *
     * @param {string} aid - 분석 ID
     */
    resume: function (aid) {
        logger.debug('restart analysis: ', aid);
        var self = this;
        return findAnalysis(aid)
            .then(function (analysis) {
                // 1. 'pending': 분석 대기중인 상태
                if (analysis.status === constant.LITE_STATUS_PENDING) {
                    // git fetch 후 분석
                    return self.start(aid);

                // 2. 'analyzing': 분석중이었던 상태
                } else if (analysis.status === constant.LITE_STATUS_ANALYZING) {
                    logger.debug('reset analysis', analysis.aid);
                    //  하위 알람 정보들 삭제 후 다시 분석 시작
                    return dbLiteAlarm.deleteAlarmsByAidAsync({ownerAid: analysis.aid})
                        .then(function () {
                            return getOptions(analysis).then(startEngine);
                        });
                }
            });
    },

    /**
     * 진행중 또는 대기중인 분석을 중단
     *
     * @param {string} aid - 분석 ID
     */
    stop: function (aid) {
        logger.debug('stop analysis: ', aid);
        if (engineIdMap.hasOwnProperty(aid)) {
            engineMgr.stop(engineIdMap[aid]);
            delete engineIdMap[aid];
        }
    },

    /**
     * 프로젝트의 분석 상태를 획득
     *  분석이 진행중인 프로젝트에 대해서는 engineMgr에 최신 상태 요청 후 업데이트&리턴
     *
     * @param {string} aid - 분석 ID
     * 분석 상태 문자열 - 'analyzing': 분석 중
     *                  'success': 분석 성공
     *                  'fail': 분석 실패
     *                  'pending': 분석 대기 중
     */
    getStatus: function (aid) {
        return findAnalysis(aid).then(function (analysis) {
            return analysis.status;
        });
    },

    /**
     * Gets a engine information

     * @returns {object} Promise resolves an engine information, rejects error message.
     */
    getEngineInfo: function () {
        return engineMgr.getEngineInfo();
    }
};

// 분석이 완료되지 않은 analysis들을 DB로부터 찾아서 분석 재시작
function restartNotCompletedAnalyses() {
    dbLiteAnalysis.getAnalysesInProgressOfAllBranchesAsync({})
        .then(function (context) {
            var analyses = context.result();
            return Promise.map(analyses, function (analysis) {
                return analyzer.resume(analysis.aid);
            });
        }).catch(function (err) {
            logger.error(err);
        });
}

// CI를 통해 서버 시작 시 테스트 분석이 먼저 수행되어야하는 경우가 있기때문에 conf의 reanalyzingDelay 사용
var delay = conf.services.jsa.reanalyzingDelay || 0;
setTimeout(restartNotCompletedAnalyses, delay);


module.exports = analyzer;
