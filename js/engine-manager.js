/* S-CORE CONFIDENTIAL
 * -------------------
 * Copyright (c) 2016 S-Core Co., Ltd. All rights reserved.
 *
 * All information contained herein is the property of S-Core.
 * Please see LICENSE file in source package.
 *
 */

'use strict';

var targetId = 100000;
var DEFAULT_TARGET_TIMEOUT = 20 * 60 * 1000; // 20 minutes

var pendingList = [];
var analyzingList = [];

// node modules
var _ = require('underscore');
var fs = require('fs');
var readline = require('readline');
var path = require('path');
var Promise = require('bluebird');

// webida modules
var logger = require('../../../common/logger-factory').getLogger('ENGINE MANAGER');

// jsa modules
var Constants = require('./constants');

var JsaError = require('../common/jsa-error');

var OPTION_ANALYSIS_TIMEOUT = '-analysis-timeout';
var OPTION_ANALYZE_RULE = '-rules';
var OPTION_BROWSER = '-browser';

var ENGINE_OUTPUT_FILE_INFO = '# File: ';

var ENGINE_OUTPUT_TIME_OUT = '* Timeout occurred during type analysis:';
var ENGINE_OUTPUT_TOTAL_TIME = '# Total time(s):';

var DEFECT_CODE_MAX_SIZE = 2000;
var DEFECT_CODE_EXTRA_SIZE = 300;
var DEFECT_CODE_ELLIPSIS = '...';
var ANALYSIS_MAX_SIZE = 4;

var Options = {
    RULES: 'rules',
    BROWSERS: 'browsers'
};

var analyzingProcessIds = [];

function canStartAnalysis() {
    if (analyzingList.length < ANALYSIS_MAX_SIZE) {
        return true;
    } else {
        return false;
    }
}

function getUniqueTargetId() {
    return targetId++;
}

function getStartIndexOfPath(text) {
    var index = text.lastIndexOf('(');
    var str = text.substring(index);
    var splitStr;
    var length;

    text = text.substring(0, index);
    splitStr = str.split(')');
    length = splitStr.length;

    if (length === 2) {
        return index;
    }

    for (var i = length; i > 2; i--) {
        index = text.lastIndexOf('(');
        text = text.substring(0, index);
    }

    return index;
}

function generateAnalysisResult(analysisTarget) {
    var analysisResult = {
        id: analysisTarget.id,
        path: analysisTarget.path,
        status: analysisTarget.status,
        typeAnalysisStatus: analysisTarget.typeAnalysisStatus,
        startTime: analysisTarget.startTime,
        files: _.map(analysisTarget.files, _.clone),
        alarms: _.map(analysisTarget.alarms, _.clone),
    };

    return analysisResult;
}

function getExtraCode(lines, line, column, extraSize, isPrev) {
    var expandableLine = lines[line - 1];
    var expandableLineLength = expandableLine.length;
    if (isPrev) {
        if (column === 1) {
            return '';
        }

        if (column <= extraSize) {
            return expandableLine.substring(0, column - 1);
        }

        if (extraSize < column) {
            return DEFECT_CODE_ELLIPSIS + expandableLine.substring(column - extraSize - 1, column - 1);
        }
    } else {
        if (column === expandableLineLength + 1) {
            return '';
        }

        if (column + extraSize < expandableLineLength + 1) {
            return expandableLine.substring(column - 1, column + extraSize) + DEFECT_CODE_ELLIPSIS;
        }

        if (expandableLineLength + 1 <= column + extraSize) {
            return expandableLine.substring(column - 1);
        }
    }
    return '';
}

function generateDefectCode(lines, startLine, startColumn, endLine, endColumn) {
    var defectCode = '';
    var defectCodeLocation = {};
    defectCodeLocation.start = {};
    defectCodeLocation.start.line = 1;
    defectCodeLocation.start.column = startColumn;
    defectCodeLocation.end = {};
    defectCodeLocation.end.line = endLine - startLine + 1;
    defectCodeLocation.end.column = endColumn;

    var isSingleLineDefect = false;

    // 순수 defect code 계산
    if (startLine === endLine) {
        isSingleLineDefect = true;
        defectCode = lines[startLine - 1].substring(startColumn - 1, endColumn - 1);
    } else {
        // 첫번째 라인
        defectCode += lines[startLine - 1].substring(startColumn - 1, lines[startLine - 1].length);
        defectCode += '\n';

        // 가운데 라인들
        if (endLine - startLine > 1) {
            var defectMiddleLines = lines.slice(startLine, endLine - 1);
            _.map(defectMiddleLines, function (line) {
                defectCode += line + '\n';
            });
        }

        // 마지막 라인
        defectCode += lines[endLine - 1].substring(0, endColumn - 1);
    }

    if (DEFECT_CODE_MAX_SIZE < defectCode.length) {
        // 순수 defect code가 DEFECT_CODE_MAX_SIZE 를 넘어선 경우
        // prev ellipsis 추가 및 location 보정
        var prevExtraCode = getExtraCode(lines, startLine, startColumn, 0, true);
        defectCodeLocation.start.column = prevExtraCode.length + 1;
        if (isSingleLineDefect) {
            defectCodeLocation.end.column = defectCodeLocation.start.column + defectCode.length;
        }
        defectCode = prevExtraCode + defectCode;

        // post ellipsis 추가
        var postExtraCode = getExtraCode(lines, endLine, endColumn, 0, false);
        defectCode += postExtraCode;
    } else {
        // 순수 defect code가 DEFECT_CODE_MAX_SIZE 보다 작은 경우
        // prev extra code 와 ellipsis 추가 및 location 보정
        var prevExtraCode = getExtraCode(lines, startLine, startColumn, DEFECT_CODE_EXTRA_SIZE, true);
        defectCodeLocation.start.column = prevExtraCode.length + 1;
        if (isSingleLineDefect) {
            defectCodeLocation.end.column = defectCodeLocation.start.column + defectCode.length;
        }
        defectCode = prevExtraCode + defectCode;

        // prev line 추가 및 location 보정
        if (prevExtraCode.length <= DEFECT_CODE_EXTRA_SIZE && 1 < startLine) {
            var prevLine = lines[startLine - 2];
            if (defectCode.length + prevLine.length < DEFECT_CODE_MAX_SIZE) {
                defectCode = prevLine + '\n' + defectCode;
                defectCodeLocation.start.line += 1;
                defectCodeLocation.end.line += 1;
            }
        }

        // post extra code 와 ellipsis 추가
        var postExtraCode = getExtraCode(lines, endLine, endColumn, DEFECT_CODE_EXTRA_SIZE, false);
        defectCode = defectCode + postExtraCode;

        // post line 추가
        if (postExtraCode.length <= DEFECT_CODE_EXTRA_SIZE && endLine < lines.length - 1) {
            var postLine = lines[endLine];
            if (defectCode.length + postLine.length < DEFECT_CODE_MAX_SIZE) {
                defectCode = defectCode + '\n' + postLine;
            }
        }
    }

    return {
        codeFragment: defectCode,
        codeFragmentLocation: defectCodeLocation
    };
}

function readCodeFragment(fileCache, filePath, location) {
    var startEnd = location.split('-');
    var startLocation = startEnd[0];
    var startLineColumn = startLocation.split(':');
    var endLocation = startEnd[1];
    var endLineColumn = endLocation.split(':');

    var startLine = Number(startLineColumn[0]);
    var startColumn = Number(startLineColumn[1]);
    var endLine = Number(endLineColumn[0]);
    var endColumn = Number(endLineColumn[1]);

    var lines = fileCache[filePath];
    if (!lines) {
        var data;
        try {
            // TODO 성능 개선점 - 파일을 전부 읽지 않고 필요한 줄만 읽도록 수정 필요
            data = fs.readFileSync(filePath, 'utf-8');
        } catch (error) {
            logger.warn(error);

            return {
                codeFragment: null,
                codeFragmentLocation: null
            };
        }
        lines = data.split('\n');
        fileCache[filePath] = lines;
    }

    return generateDefectCode(lines, startLine, startColumn, endLine, endColumn);
}

function getAlarmFromLinedLog(fileCache, linedLog, rootDirectoryPath) {
    var impact;
    var name;
    var cause;
    var file;
    var location;
    var step1Text;
    var step2Text;
    var step3Text;
    var index;

    // logger.debug('[linedLog]', linedLog);

    if (linedLog.indexOf('[High]') === -1 && linedLog.indexOf('[Medium]') === -1 && linedLog.indexOf('[Low]') === -1) {
        return null;
    }

    /*example :
     *      linedLog === '[High][ACCESS_PROPERTY_OF_FALSY_VALUE] ie8, ie9 browsers do not support ['async'] property of ['HTMLScriptElement'] interface (js/index.html_1432.36.js:11:3-11:11)'
     */

    step1Text = linedLog.split('] ');

    /*example :
     *      step1Text[0] === '[High][ACCESS_PROPERTY_OF_FALSY_VALUE'
     *      step1Text[1] === 'ie8, ie9 browsers do not support ['async''
     *      step1Text[2] === 'property of ['HTMLScriptElement'''
     *      step1Text[3] === 'interface (js/index.html_1432.36.js:11:3-11:11)''
     */

    //parse impact
    impact = step1Text[0].split('[')[1].split(']')[0];

    /*example :
     *      impact === 'High' || 'Medium' || 'Low'
     */

    //parse name
    name = step1Text[0].split('[')[2];

    /*example :
     *      name === 'ACCESS_PROPERTY_OF_FALSY_VALUE'
     */

    //parse cause
    step2Text = linedLog.substring(linedLog.indexOf('] ') + 2);

    /*example :
     *      cause에 '] '가 있는 경우가 있으므로 step1Text[1]을 바로 쓰지 않고 step2Text를 새로 만듦
     *      step2Text === 'ie8, ie9 browsers do not support ['async'] property of ['HTMLScriptElement'] interface (js/index.html_1432.36.js:11:3-11:11)'
     *      step2Text === 'document.form1 is undefined (@eval(6):1:1-1:15)' //파일이름안에 '(' ')'가 포함된 경우가 있어 getStartIndexOfPath를 통해 시작 '(' index를 계산
     */

    index = getStartIndexOfPath(step2Text);
    cause = step2Text.substring(0, index);

    /*example :
     *      cause === 'ie8, ie9 browsers do not support ['async'] property of ['HTMLScriptElement'] interface '
     *      cause === 'document.form1 is undefined '
     */

    step3Text = step2Text.substring(index + 1);

    /*example :
     *      step3Text === 'js/index.html_1432.36.js:11:3-11:11)'
     */

    //parse file
    index = step3Text.indexOf(':');
    file = step3Text.substring(0, index);

    /*example :
     *      file === 'js/index.html_1432.36.js'
     */

    //parse location
    location = step3Text.substring(index + 1, step3Text.length - 1);

    /*example :
     *      location === '11:3-11:11'
     */

    var filePath = path.join(rootDirectoryPath, file);
    var codeFragment = readCodeFragment(fileCache, filePath, location);

    return {
        impact: impact,
        name: name,
        message: cause,
        filePath: file,
        location: location,
        codeFragment: codeFragment.codeFragment,
        codeFragmentLocation: codeFragment.codeFragmentLocation
    };
}

function createAnalysisCommand(analysisTarget) {
    // -20 option : nice command param for low cpu priority
    var analysisCmd = ['-20', 'bugda', 'analyze', analysisTarget.path, '-no-verbose-iteration'];

    // -rules 옵션 처리
    analysisCmd.push(OPTION_ANALYZE_RULE);
    analysisCmd.push(analysisTarget.option[Options.RULES].join(' '));

    // -browser 옵션 처리
    // null 인 경우 모든 브라우저 검사를 해야 하므로, 엔진에 아무런 옵션을 주지 않는다
    if (analysisTarget.option[Options.BROWSERS] !== null) {
        analysisCmd.push(OPTION_BROWSER);
        if (analysisTarget.option[Options.BROWSERS].length > 0) {
            analysisCmd.push(analysisTarget.option[Options.BROWSERS].join(' '));
        } else {
            analysisCmd.push('');
        }
    }

    return analysisCmd;
}

function createLiteAnalysisCommand(analysisTarget) {
    // -20 option : nice command param for low cpu priority
    var analysisCmd = ['-20', 'bugda', 'lite', analysisTarget.path];

    // -rules 옵션 처리
    analysisCmd.push(OPTION_ANALYZE_RULE);
    analysisCmd.push(analysisTarget.option[Options.RULES].join(' '));

    return analysisCmd;
}

// 분석을 마무리.
function finishingAnalysis(analysisTarget) {
    var err = null;

    // 엔진 TIMEOUT
    if (analysisTarget.typeAnalysisStatus !== Constants.LITE_STATUS_TIMEOUT) {
        analysisTarget.typeAnalysisStatus = Constants.LITE_STATUS_SUCCESS;
    }
    // 정상 분석 종료
    if (analysisTarget.status === Constants.LITE_STATUS_SUCCESS) {
        err = null;
    }
    // 강제 분석 종료
    else if (analysisTarget.status === Constants.LITE_STATUS_STOP) {
        err = 'analysis stopped (ENGINE STOP)';
    }
    // 분석 TIMEOUT 종료
    else if (analysisTarget.status === Constants.LITE_STATUS_TIMEOUT) {
        err = 'analysis timeout (ENGINE TIMEOUT) : ' + analysisTarget.timeout + 'ms';
    }
    // 분석중 비정상 종료
    else if (analysisTarget.status === Constants.LITE_STATUS_ANALYZING) {
        err = 'analysis failed (ENGINE ERROR)';
        analysisTarget.status = Constants.LITE_STATUS_FAIL;
        analysisTarget.typeAnalysisStatus = Constants.LITE_STATUS_FAIL;
    }
    // 그 밖의 비정상 종료
    else {
        err = 'analysis failed (' + analysisTarget.status + ')';
        analysisTarget.status = Constants.LITE_STATUS_FAIL;
        analysisTarget.typeAnalysisStatus = Constants.LITE_STATUS_FAIL;
    }
    analysisTarget.doneCallback(err, generateAnalysisResult(analysisTarget));
}

function analyzePendingTarget() {
    var analysisTarget, spawn, analyzingProcess, timeoutTimer;

    if (pendingList.length <= 0) {
        return;
    }

    if (canStartAnalysis() !== true) {
        return;
    }

    analysisTarget = pendingList.shift();

    analyzingList.push(analysisTarget);

    spawn = require('child_process').spawn;
    var command = createLiteAnalysisCommand(analysisTarget);
    analyzingProcess = spawn('nice', command, {detached: true});
    analyzingProcessIds.push(analyzingProcess.pid);

    logger.debug('spawn(analyze) : ', command, ' pid :', analyzingProcess.pid);

    if (!analysisTarget.timeout) {
        analysisTarget.timeout = DEFAULT_TARGET_TIMEOUT;
    }

    analysisTarget.process = analyzingProcess;
    analysisTarget.startTime = Date.now();
    analysisTarget.status = Constants.LITE_STATUS_ANALYZING;
    if (analysisTarget.startedCallback) {
        analysisTarget.startedCallback(Constants.LITE_STATUS_ANALYZING);
    }
    logger.debug('analyzePendingTarget : ', analysisTarget.id, analysisTarget.status);

    timeoutTimer = setTimeout(function () {
        if (analysisTarget.status === Constants.LITE_STATUS_ANALYZING) {
            logger.debug('timeout :', analysisTarget.path, ' pid :', analyzingProcess.pid);

            analysisTarget.status = Constants.LITE_STATUS_TIMEOUT;
            process.kill(-analyzingProcess.pid);
        }
    }, analysisTarget.timeout);

    var targetPath = analysisTarget.path;
    var rootDirectoryPath = targetPath;
    var logPath = path.join(targetPath, 'bugda.log');
    var logStream = fs.createWriteStream(logPath);
    // defect code 구할때 동일 파일을 여러번 readFile(), split() 하지 않도록 caching
    var fileCache = {};

    analyzingProcess.stderr.pipe(logStream, {
        end: false
    });

    analyzingProcess.stdout.pipe(logStream, {
        end: false
    });

    readline.createInterface({
        input: analyzingProcess.stdout,
        terminal: true
    }).on('line', function (linedLog) {
        if (analysisTarget.status !== Constants.LITE_STATUS_ANALYZING) {
            return;
        }

        var alarmInfo = getAlarmFromLinedLog(fileCache, linedLog, rootDirectoryPath);
        if (alarmInfo !== null) {
            analysisTarget.alarms.push(alarmInfo);
        }

        /*example
             # File:   6955   3511  jindo2.js
             # File:   1548   1071  underscore_test.js
        **/
        else if (linedLog.indexOf(ENGINE_OUTPUT_FILE_INFO) > -1) {
            var tokens = linedLog.split(/[ ]+/g);
            var file = {
                name: tokens[4],
                loc: parseInt(tokens[3]),
                totalLines: parseInt(tokens[2])
            }
            analysisTarget.files.push(file);
        }

        else if (linedLog.indexOf(ENGINE_OUTPUT_TIME_OUT) > -1) {
            logger.debug('type analysis timeout', analysisTarget.path);
            analysisTarget.typeAnalysisStatus = Constants.LITE_STATUS_TIMEOUT;
        }

        // 엔진에서 정상 종료일 때 # Total time(s): XX를 출력
        else if (linedLog.indexOf(ENGINE_OUTPUT_TOTAL_TIME) > -1) {
            analysisTarget.status = Constants.LITE_STATUS_SUCCESS;
            logger.debug('analyzePendingTarget : ', analysisTarget.id, analysisTarget.status);
        }
    });

    // 정상이나 child_process의 kill 또는 error disconnect등 프로세스 종료시에 close 이벤트가 호출 되므로 여기서 종료 처리
    analyzingProcess.on('close', function (code, signal) {
        clearTimeout(timeoutTimer);
        logStream.close();

        var index = analyzingProcessIds.indexOf(analyzingProcess.pid);
        analyzingProcessIds.splice(index, 1);

        finishingAnalysis(analysisTarget);

        var index = analyzingList.indexOf(analysisTarget);
        analyzingList.splice(index, 1);
        logger.debug('analyzePendingTarget : analyze process closed ', analysisTarget.id, analysisTarget.status);

        analyzePendingTarget();
    });

    // error나 disconnect시 exit은 호출되지 않는 경우가 있으므로 close에서 종료 처리
    analyzingProcess.on('exit', function (code, signal) {
        logger.debug('analyzePendingTarget : exit code(' + code + ') signal(' + signal + ')');
    });

    analyzingProcess.on('error', function (err) {
        logger.error('analyzePendingTarget : ', err);
        if (analysisTarget.status === Constants.LITE_STATUS_ANALYZING) {
            analysisTarget.status = Constants.LITE_STATUS_FAIL;
        }
    });

    analyzingProcess.on('disconnect', function () {
        logger.error('analyzePendingTarget : analyze process disconnected');
        if (analysisTarget.status === Constants.LITE_STATUS_ANALYZING) {
            analysisTarget.status = Constants.LITE_STATUS_FAIL;
        }
    });
}

/**
 * Starts analysis.
 *
 * @param {string} targetPath - 분석하려는 파일 패스
 * @param {object} option - 분석에 사용할 옵션 객체
 * @param {array} option.RULES - 분석에 사용할 룰 배열
 * @param {function} startedCallback - 분석 시작 콜백
 * @param {function} doneCallback - 분석 종료 결과 콜백
 */
function start(targetPath, option, startedCallback, doneCallback) {
    var analysisTarget = {};

    if (!doneCallback) {
        logger.warn('must specifiy callback for receiving results of engine.');
        return;
    }

    if (!targetPath) {
        logger.warn('must specifiy targetPath to analyze.');
        return doneCallback('targetPath should not be empty');
    }

    analysisTarget.id = getUniqueTargetId();
    analysisTarget.path = targetPath;
    analysisTarget.option = option;
    analysisTarget.files = [];
    analysisTarget.alarms = [];
    analysisTarget.status = Constants.LITE_STATUS_PENDING;
    analysisTarget.doneCallback = doneCallback;
    analysisTarget.startedCallback = startedCallback;

    logger.debug('start : ', analysisTarget.id, analysisTarget.status);

    fs.stat(analysisTarget.path, function (err, stats) {
        if (err) {
            logger.error('start : ', err);
            doneCallback('start failed');
        } else {
            if (stats.isDirectory() === true) {
                pendingList.push(analysisTarget);
                analyzePendingTarget();
            } else {
                logger.error('start : ', analysisTarget.path + ' is not a file');
                doneCallback(analysisTarget.path + ' is not a file');
            }
        }
    });

    return analysisTarget.id;
}

/**
 * @callback startCallback
 *
 * @param {string|null} error - 에러 문자열
 * @param {object|null} analysisResult - 분석 결과 객체
 * @param {string} analysisResult.id 분석 ID
 * @param {string} analysisResult.status 분석 상태. STATUS_ANALYZING | STATUS_SUCCESS | STATUS_PENDING | STATUS_FAIL | STATUS_TIMEOUT | STATUS_STOP
 * @param {string} analysisResult.path 분석하려는 파일 패스
 * @param {array} analysisResult.alarms 검출한 알람
 */


/**
 * Stop analysis.
 *
 * @param {array} pageList - 멈추고자 하는 분석의 {페이지 ID : 내부 분석 ID} 쌍으로된 리스트
 */
function stop(targetId) {
    var i;
    var analysisTarget;
    var removedTargetIds = [];

    //대기중인 모든 분석 중 정지하려는 분석을 제거
    for (i = 0; i < pendingList.length; i++) {
        if (pendingList[i].id === targetId) {
            analysisTarget = pendingList[i];
            pendingList.splice(i, 1);
            analysisTarget.status = Constants.LITE_STATUS_STOP;
            finishingAnalysis(analysisTarget);
            removedTargetIds.push(targetId);
            logger.debug('stop : pending target removed', analysisTarget.id);
            break;
        }
    }

    // 분석중인 프로세스 중 정지하려는 분석의 프로세스를 kill
    var analyzingProcess = null;
    for (i = 0; i < analyzingList.length; i++) {
        if (analyzingList[i].id === targetId) {
            analyzingList[i].status = Constants.LITE_STATUS_STOP;
            analyzingProcess = analyzingList[i].process;
            if (analyzingProcess) {
                try {
                    process.kill(-analyzingProcess.pid);
                    // process.on :'close'가 호출되고 status는 status_stop 상태가 됨
                } catch (e) {
                    logger.debug('process ', analyzingProcess.pid, ' was not exists');
                }
            }
            break;
        }
    }
}

function getStatus(targetId) {
    var i;

    var pendingLength = pendingList.length;
    for (i = 0; i < pendingLength; i++) {
        if (pendingList[i].id === targetId) {
            logger.debug('getStatus : ', Constants.LITE_STATUS_PENDING);
            return Constants.LITE_STATUS_PENDING;
        }
    }

    var analyzingLength = analyzingList.length;
    for (i = 0; i < analyzingLength; i++) {
        if (analyzingList[i].id === targetId) {
            logger.debug('getStatus : ', Constants.LITE_STATUS_ANALYZING);
            return Constants.LITE_STATUS_ANALYZING;
        }
    }

    return null;
}

function stopAllAnalyses() {
    var length = analyzingProcessIds.length;
    for (var i = 0; i < length; i++) {
        var pid = analyzingProcessIds[i];
        try {
            process.kill(-pid);
        } catch (e) {
            logger.debug('process ', pid, ' was not exists');
        }
    }
    analyzingProcessIds = [];
}
/**
 * Gets an engine information
 *
 * @returns {object} Promise resolves an engine information, rejects error message.
 */
function getEngineInfo() {
    return new Promise(function (resolve, reject) {
        var spawn = require('child_process').spawn;
        var bugda = spawn('bugda', ['-v']);
        var stdout = '';
        var isFailed = false;

        readline.createInterface({
            input: bugda.stdout,
            terminal: true
        }).on('line', function (linedLog) {
            logger.debug('linedLog', linedLog);
            stdout += linedLog + '\n';
        });

        bugda.on('close', function (code, signal) {
            if (isFailed || !stdout) {
                reject('failed to get engine information.');
            } else {
                // stdout: JavaScript Analyzer version 0.2.0\nCopyright (c) 2016 S-Core, Ltd.\nAll rights reserved.
                logger.debug('[engine information]', stdout);
                var data = stdout.split('\n')[0].split(' version ');
                var engineInfo = {
                    name: data[0],
                    version: data[1]
                };

                resolve(engineInfo);
            }
        });

        bugda.on('error', function (err) {
            logger.error('error occurred while getting engine information.', err);
            isFailed = true;
        });

        bugda.on('disconnect', function () {
            logger.error('process disconnected while getting engine information.');
        });
    });
}

exports.start = start;
exports.stop = stop;
exports.getStatus = getStatus;
exports.Options = Options;
exports.stopAllAnalyses = stopAllAnalyses;
exports.getEngineInfo = getEngineInfo;
