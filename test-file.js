/* S-CORE CONFIDENTIAL
 * -------------------
 * Copyright (c) 2016 S-Core Co., Ltd. All rights reserved.
 *
 * All information contained herein is the property of S-Core.
 * Please see LICENSE file in source package.
 *
 */

'use strict';
var _ = require('lodash');
var requestCall = require('request');
var logger = require('../../../common/logger-factory').getLogger('JSA GITHUB UTIL');
var JsaError = require('./jsa-error');

var GITHUB_URLS = {
    EMAILS: '/user/emails',
    REPOS: '/user/repos',
    USER: '/user',
    USERS: '/users',
    REPOS_HOOK_URL: _.template('/repos/<%= url %>/hooks')
};

var requestMethod = {
    post: 'POST',
    delete: 'DELETE',
    get: 'GET',
    put: 'PUT'
};

function checkGitHubAccessToken(accessToken) {
    if (!accessToken) {
        // github access token은 deepscan 사이트에서 로그인 할 때, jsa-auth-manager에서 github가 발급해주는 access token을 session에 저장하고 있다.
        // github로 로그인하지않은 계정일 경우(e.g. curl) github access token이 없기때문에 github api를 사용할 수 없다.
        return Promise.reject(new JsaError('There is no GitHub access token'));
    } else {
        return Promise.resolve();
    }
}

function _requestToGitHub(url, accessToken, method, payload) {
    // GitHub API를 사용할 때 User-Agent는 반드시 필요하며, GitHub User Name이나 Application Name 을 입력해야한다.
    // User-Agent가 invalid 하다면 403 Forbidden 에러를 리턴한다. - https://developer.github.com/v3/#user-agent-required
    var options = {
        url: 'https://api.github.com' + url + (accessToken ? '?access_token=' + accessToken : ''),
        method: method || requestMethod.get,
        json: true,
        headers: {'User-Agent': 'DeepScan'}
    };
    if (payload) {
        options.body = payload;
    }
    return new Promise(function (resolve, reject) {
        logger.debug('request to github: ', options);

        requestCall(options, function (error, response, body) {
            var code = parseInt(response.statusCode / 100);
            if (error) {
                reject(new JsaError(error));
            } else if (code !== 2) {
                // status code가 2XX 가 아니면 error
                logger.error('request error. cause: ', body)
                reject(new JsaError(response.statusCode), response.statusCode);
            } else {
                logger.debug('requested successfully : ', options);
                resolve(body);
            }
        });
    });
}

function request(url, accessToken, method, payload) {
    return checkGitHubAccessToken(accessToken)
        .then(function () {
            return _requestToGitHub(url, accessToken, method, payload);
        });
}

function requestWithoutAccessToken(url) {
    return _requestToGitHub(url);
}

module.exports.request = request;
module.exports.requestMethod = requestMethod;
module.exports.requestWithoutAccessToken = requestWithoutAccessToken;
module.exports.GITHUB_URLS = GITHUB_URLS;
