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
var workerFarm = require('worker-farm');

// webida modules
var logger = require('../../../common/logger-factory').getLogger('HISTORICAL DEFECT MERGER');

// jsa modules
var constants = require('./constants');

var jsaDao = require('../common/jsa-dao');
var JsaError = require('../common/jsa-error');


var dbLiteAnalysis = jsaDao.dbLiteAnalysis;
var dbLiteDefect = jsaDao.dbLiteDefect;

var diffWorker = workerFarm(require.resolve('../common/defect-file-diff-worker'));
var promisifiedDiffWorker = Promise.promisify(diffWorker);

function makeCode(codes, locationString) {
    var location = JSON.parse(locationString);
    var start = location.start;
    var startLine = start.line;
    var startColumn = start.column;
    var end = location.end;
    var endLine = end.line;
    var endColumn = end.column;
    var newCode = '';

    for (var i = startLine - 1; i < endLine; i++) {
        if (i === startLine - 1 && i === endLine - 1) {
            newCode += codes[i].substring(startColumn - 1, endColumn - 1);
        } else if (i === startLine - 1) {
            newCode += codes[i].substring(startColumn - 1);
        } else if (i === endLine - 1) {
            newCode += codes[i].substring(0, endColumn - 1);
        } else {
            newCode += codes[i];
        }
    }

    return newCode;
}

function parseAlarmLocation(strLocation) {
    var regExp = /[0-9]+/g;
    var locationArray = strLocation.match(regExp);

    return {
        startLine: parseInt(locationArray[0], 10),
        endLine: parseInt(locationArray[2], 10),
        startColumn: parseInt(locationArray[1], 10),
        endColumn: parseInt(locationArray[3], 10)
    };
}

function stringifyLocation(location) {
    return location.startLine + ':' + location.startColumn + '-' + location.endLine + ':' + location.endColumn;
}

/**
 * 결함의 이전 파일 위치를 계산하여 리턴한다.
 * 이전 분석 파일과 이번 분석 파일의 diff 정보를 이용한다.
 *
 * @param {object} alarm - 결함 객체
 * @param {object} diffChars - diff 객체
 * @return {object} 새로 추가되거나 변경된 라인이라면 null을 리턴. 기존 존재하던 라인이라면 계산된 값을 stringify 하여 리턴.
 */
function getLastDetectedLocationByDiffChars(alarm, diffChars) {
    var currentLine = 1;
    var currentColumn = 1;
    var alarmLocation = parseAlarmLocation(alarm.location);
    var prevLocation = _.clone(alarmLocation);
    var diffCharsLength = diffChars.length;

    var addedLine = 0;
    var removedLine = 0;
    var addedColumn = 0;
    var removedColumn = 0;

    var nextLine;
    var nextColumn;

    for (var i = 0; i < diffCharsLength; i++) {
        var part = diffChars[i];
        var values = part[1].split('\n');
        var newLineLength = values.length - 1;
        var lastColumnLength = values[newLineLength].length;

        nextLine = currentLine + newLineLength;
        if (newLineLength === 0) {
            nextColumn = currentColumn + lastColumnLength;
        } else {
            nextColumn = lastColumnLength + 1;
        }

        if (part[0] === -1) {
            if (newLineLength === 0) {
                // 라인안의 블럭만 삭제되었다면 삭제된 컬럼수 증가
                removedColumn += lastColumnLength;
            } else {
                // 새로운 라인이 시작되었다면 마지막 라인의 컬럼수 저장
                removedColumn = lastColumnLength;
            }

            removedLine += newLineLength;

            // 삭제된 경우 라인과 컬럼의 위치를 변화시킬 필요 없음
            nextLine = currentLine;
            nextColumn = currentColumn;
        } else if (part[0] === 1) {
            // 현재 결함에 해당하는 라인이 새로 추가된 라인이라면 기존 파일에 없던 내용이므로 이전 분석에서의 위치는 존재하지 않음
            if (alarmLocation.startLine < nextLine || (alarmLocation.startLine === nextLine && alarmLocation.startColumn <
                                                       nextColumn)) {
                return null;
            }

            if (newLineLength === 0) {
                addedColumn += lastColumnLength;
            } else {
                addedColumn = lastColumnLength;
            }

            addedLine += newLineLength;
        } else {
            // 결함의 시작점이 기존 존재하던 내용일 경우 삭제된 라인수, 컬럼수 만큼 더하고 추가된 라인수, 컬럼수 만큼 삭제하여 이전 위치를 기록
            if (alarmLocation.startLine < nextLine || (alarmLocation.startLine === nextLine && alarmLocation.startColumn <
                                                       nextColumn)) {
                // 결함의 시작 라인이 현재 라인과 다르다면 추가된 컬럼수 초기화
                if (alarmLocation.startLine !== currentLine) {
                    addedColumn = 0;
                    removedColumn = 0;
                }

                prevLocation.startLine = alarmLocation.startLine - addedLine + removedLine;
                prevLocation.startColumn = alarmLocation.startColumn - addedColumn + removedColumn;
            }
            // 결함의 종료점이 기존 존재하던 내용일 경우 삭제된 라인수, 컬럼수 만큼 더하고 추가된 라인수, 컬럼수 만큼 삭제하여 이전 위치를 기록하고 이전 정보를 리턴
            // 결함의 종료점은 다음 컬럼 시작점으로 기록 되므로 <=로 검사
            if (alarmLocation.endLine < nextLine || (alarmLocation.endLine === nextLine && alarmLocation.endColumn <=
                                                     nextColumn)) {
                if (alarmLocation.endLine !== currentLine) {
                    addedColumn = 0;
                    removedColumn = 0;
                }
                prevLocation.endLine = alarmLocation.endLine - addedLine + removedLine;
                prevLocation.endColumn = alarmLocation.endColumn - addedColumn + removedColumn;

                return stringifyLocation(prevLocation);
            }
            // 새로운 라인이 추가되었다면 컬럼수 정보 초기화
            if (newLineLength !== 0) {
                addedColumn = 0;
                removedColumn = 0;
            }
        }

        currentLine = nextLine;
        currentColumn = nextColumn;
    }

    return null;
}


function diffCharsOfFile(fsPath, prevCrawlPath, currentCrawlPath) {
    var prevPath = path.normalize(path.join(prevCrawlPath, fsPath));
    var currentPath = path.normalize(path.join(currentCrawlPath, fsPath));

    return promisifiedDiffWorker(prevPath, currentPath).then(function (diffChars) {
        return {
            fsPath: fsPath,
            diffChars: diffChars
        };
    }).catch(function (error) {
        logger.warn(error);
        return null;
    });
}


/**
 * 결함의 이전분석의 crawlPath 로부터 알람의 이전 파일 위치를 계산하여 리턴한다.
 *
 * @param {object} currentAnalysis - 현재 분석 객체
 * @param {object} alarm - 이전 파일위치를 알고자하는 알람
 * @param {string} lastDetectedAnalysisFsPath - 결함의 이전분석의 FsPath
 * @return {array} 이전 분석과 비교가 실패하면 null을 resolve. 비교가 성공하면 location 정보를 resolve.
 */
function getLastDetectedLocation(currentAnalysis, alarm, lastDetectedAnalysisFsPath) {
    //logger.debug('[getLastDetectedLocation]', alarm, lastDetectedAnalysisFsPath);
    var fsPath = alarm.fsPath;
    return diffCharsOfFile(fsPath, lastDetectedAnalysisFsPath, currentAnalysis.fsPath).then(function (diffChars) {
        //logger.debug('[diffChars]', diffChars);
        if (diffChars && fsPath === diffChars.fsPath) {
            return getLastDetectedLocationByDiffChars(alarm, diffChars.diffChars);
        }
        return null;
    }).catch(function (error) {
        logger.warn(error);
        return null;
    });
}

/**
 * alarm과 defect이 같은 결함인지 file 내용까지 비교 후 판단
 *  defect이 마지막으로 발생한 분석의 crawlPath 내 alarm과 같은 파일이 있는지 여부를 검사
 *  같은 파일이 존재한다면 파일을 읽어 결함 내용 diff를 통해 같은 결함인지 비교 후 true/false 리턴
 * @param {object} alarm - 비교할 alarm 객체
 * @param {object} defect - 비교할 defect 객체
 * @param {object} analysis - 분석 객체
 * @return {boolean} 같은 결함이라면 true resolve. 같은 결함이 아니라면 false resolve.
 */
function isSameDefect(alarm, defect, analysis) {
    return new Promise(function (resolve, reject) {
        if (alarm.name === defect.name &&
            alarm.impact === defect.impact &&
            alarm.message === defect.message &&
            alarm.fsPath === defect.fsPath) {

            return new Promise(function (res, rej) {
                var isSameAnalysis = (analysis.aid === defect.lastDetectedAnalysisId);
                if (!isSameAnalysis) {
                    // 비교할 defect의 마지막 분석의 소스 location 을 얻어옴
                    getLastDetectedLocation(analysis, alarm, defect.lastDetectedAnalysisFsPath).then(function (lastDetectedLocation) {
                        res(lastDetectedLocation);
                    }).catch(function (err) {
                        logger.warn(err);
                        res(null);
                    });
                } else {
                    res(alarm.location);
                }
            }).then(function (lastDetectedLocation) {
                if (lastDetectedLocation === defect.location) {
                    var targetCodeFragment = alarm.codeFragment;
                    var targetCodeFragmentLocation = alarm.codeFragmentLocation;

                    var prevCodeFragment = defect.codeFragment;
                    var prevCodeFragmentLocation = defect.codeFragmentLocation;

                    var targetCodes;
                    var prevCodes;

                    try {
                        if (targetCodeFragment && targetCodeFragment.split) {
                            targetCodes = makeCode(targetCodeFragment.split('\n'), targetCodeFragmentLocation);
                        } else {
                            targetCodes = null;
                        }

                        if (prevCodeFragment && prevCodeFragment.split) {
                            prevCodes = makeCode(prevCodeFragment.split('\n'), prevCodeFragmentLocation);
                        } else {
                            prevCodes = null;
                        }
                    } catch (e) {
                        logger.error(e);
                        resolve(false);
                    }

                    if (targetCodes === prevCodes) {
                        resolve(true);
                    }
                }
                resolve(false);
            })
        }
        resolve(false);
    })
}

function getBranchDefects(branchId) {
    return dbLiteDefect.$findAsync({
        ownerBid: branchId
    }).then(function (context) {
        return context.result();
    }).catch(function () {
        return [];
    });
}

function getBranchOutstandingDefects(branchId) {
    return getBranchDefects(branchId).then(function (defects) {
        return _.filter(defects, function (defect) {
            return defect.status === constants.LITE_DEFECT_STATUS_NEW || defect.status === constants.LITE_DEFECT_STATUS_TRIAGED;
        });
    });
}

/**
 * 머지 대상이 될 Defect 리스트 리턴.
 * @param {string} branchId - 브랜치 Id
 * @return {array} defects 결함 객체
 */
function getMergeableTargetDefects(branchId) {
    var aidCache = {};
    return dbLiteDefect.getDefectsAsync({
        ownerBranchIds: [branchId],
        statuses: [constants.LITE_DEFECT_STATUS_NEW, constants.LITE_DEFECT_STATUS_TRIAGED, constants.LITE_DEFECT_STATUS_DISMISSED]
    }).then(function (context) {
        var defects = context.result();
        return Promise.map(defects, function (defect) {
            if (!aidCache[defect.lastDetectedAnalysisId]) {
                return dbLiteAnalysis.$findOneAsync({
                    aid: defect.lastDetectedAnalysisId
                }).then(function (context) {
                    var row = context.result();
                    aidCache[defect.lastDetectedAnalysisId] = row.fsPath;
                    defect.lastDetectedAnalysisFsPath = row.fsPath;
                    return defect;
                })
            } else {
                defect.lastDetectedAnalysisFsPath = aidCache[defect.lastDetectedAnalysisId];
                return defect;
            }
        });
    }).catch(function (err) {
        logger.error(err);
        throw new JsaError(err);
    });
}

/**
 * 결함의 상태를 FIXED로 업데이트 후 결함 객체 리턴
 * @param {object} defect - 결함 객체
 * @param {string} aid - 현재 분석 id
 * @return {object} FIXED로 업데이트 된 결함 객체
 */
function updateDefectToFixed(defect, aid) {
    defect.status = constants.LITE_DEFECT_STATUS_FIXED;
    defect.eliminatedAnalysisId = aid;
    return defect;
}

/**
 * 결함을 알람의 정보로 업데이트 후 결함 객체 리턴
 * @param {object} defect - 결함 객체
 * @param {object} alarm - 결함을 업데이트 할 base가 되는 알람 객체
 * @param {string} aid - 분석 id
 * @return {object} 업데이트 된 결함 객체
 */
function updateDefectWithAlarm(defect, alarm, aid) {
    defect.location = alarm.location;
    defect.codeFragment = alarm.codeFragment;
    defect.codeFragmentLocation = alarm.codeFragmentLocation;
    defect.lastDetectedAnalysisId = aid;
    defect.alarmIds = Array.isArray(defect.alarmIds) ? defect.alarmIds.concat(alarm.alarmId) : [alarm.alarmId];
}

/**
 * 새로운 결함 객체를 생성 후 리턴
 * @param {object} alarm - 결함을 생성할 base가 되는 알람 객체
 * @param {string} ownerBid - 브랜치 id
 * @param {string} aid - 분석 id
 * @return {object} 결함 객체
 */
function createNewDefectFromAlarm(alarm, ownerBid, aid) {
    return {
        ownerBid: ownerBid,
        name: alarm.name,
        impact: alarm.impact,
        message: alarm.message,
        fsPath: alarm.fsPath,
        path: alarm.path,
        location: alarm.location,
        codeFragment: alarm.codeFragment,
        codeFragmentLocation: alarm.codeFragmentLocation,
        firstDetectedAnalysisId: aid,
        lastDetectedAnalysisId: aid,
        status: constants.LITE_DEFECT_STATUS_NEW,
        alarmIds: [alarm.alarmId]
    };
}


/**
 * 결함 리스트를 받아 알람의 내용을 반영한 새로운 결함리스트를 리턴
 *  1. 결함리스트 중 알람과 같은 결함이 없다면 새로운 결함을 추가한 결함리스트 리턴
 *  2. 결함리스트 중 알람과 같은 결함이 있다면 알람의 정보로 업데이트 한 결함리스트 리턴
 * @param {object} alarm - 알람 객체
 * @param {array} prevDefects - 이전 분석의 결함들
 * @param {array} newDefects - 이번 분석에 새로 생성된 결함들
 * @param {object} analysis - 분석 객체
 * @return {object} 결함 객체
 */
function mergeAlarmWithMergedDefects(alarm, prevDefects, newDefects, analysis) {
    var aid = analysis.aid;
    var bid = analysis.ownerBid;
    var isHit = false;

    /* NOTE: isSameDefect()은 파일 read 후 code diff를 수행하므로 비용이 큼.
     *       prevDefects는 중복이 없으므로 같은 Defect을 찾은 이후에는 더이상 isSameDefect()으로 비교 할 필요 없음.
     *       하지만 Promise에는 .find() API가 없으므로 Promise.each()를 사용하는 대신 find 효과를 내기위해 flag를 두어 불필요한 파일 연산을 막음.
     */
    return Promise.each(prevDefects, function (prevDefect) {
        return !isHit && isSameDefect(alarm, prevDefect, analysis).then(function (result) {
            if (result) {
                isHit = true;
                updateDefectWithAlarm(prevDefect, alarm, aid);
            }
        });
    }).then(function () {
        if(!isHit) {
            return Promise.each(newDefects, function (newDefect) {
                return !isHit && isSameDefect(alarm, newDefect, analysis).then(function (result) {
                    if (result) {
                        isHit = true;
                        updateDefectWithAlarm(newDefect, alarm, aid);
                    }
                })
            });
        }
    }).then(function () {
        if (!isHit) {
            newDefects.push(createNewDefectFromAlarm(alarm, bid, aid));
        }
    });
}

/**
 * 이전 분석의 결함들과 이번 분석의 알람들을 머징한 결과 결함들을 리턴
 * @param {object} analysis - 분석 객체
 * @param {array} newAlarms - 분석 결과 알람들
 * @return {array} 머징된 결함들
 */
function mergeAlarms(analysis, newAlarms) {
    var branchId = analysis.ownerBid;
    // 이전 분석의 머징 대상 Defects 도출 (NEW, TRIAGED, DISMISSED)
    return getMergeableTargetDefects(branchId)
        .then(function (prevDefects) {
            logger.debug('[prevDefects size]', prevDefects.length);
            var newDefects = [];

            // 업데이트 된 이전 분석의 Defects 및 새로 생성된 Defects
            return Promise.each(newAlarms, function (newAlarm) {
                return mergeAlarmWithMergedDefects(newAlarm, prevDefects, newDefects, analysis);
            }).then(function () {
                // 1. 이전 분석의 Defects 중 이번 분석에서도 발견된 Defects
                var hitDefects = _.filter(prevDefects, function (defect) {
                    return defect.lastDetectedAnalysisId === analysis.aid;
                });
                logger.debug('[ 1. hitDefects size]', hitDefects.length);

                // 2. 이전 분석의 Defects 중 이번 분석에서 발견되지 않은 Defects
                var nohitDefects = _.filter(prevDefects, function (defect) {
                    return defect.lastDetectedAnalysisId !== analysis.aid;
                });
                logger.debug('[ 2. nohitDefects size]', nohitDefects.length);

                nohitDefects = _.map(nohitDefects, function (restDefect) {
                    logger.debug('update Fixed', restDefect.did);
                    // 같은 알람을 찾지 못한 Defect인 경우 FIXED 로 업데이트
                    return updateDefectToFixed(restDefect, analysis.aid);
                });

                // 3. 이번 분석에서 새로 발견된 Defects
                logger.debug('[ 3. newDefects size]', newDefects.length);

                // 1, 2가 서로 배타적이지 않은 경우 error message 리턴
                if ((hitDefects.length + nohitDefects.length) !== prevDefects.length) {
                    logger.error('Wrong update prevDefects!!!');
                }

                // 1, 2, 3을 합친 최종 Defects 리턴
                return _.union(prevDefects, newDefects);
            })
        });
}

exports.getBranchDefects = getBranchDefects;
exports.getBranchOutstandingDefects = getBranchOutstandingDefects;
exports.mergeAlarms = mergeAlarms;
