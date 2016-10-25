/* S-CORE CONFIDENTIAL
 * -------------------
 * Copyright (c) 2016 S-Core Co., Ltd. All rights reserved.
 *
 * All information contained herein is the property of S-Core.
 * Please see LICENSE file in source package.
 *
 */

define([
    'underscore',
    'webida-lib/util/logger/logger-client',
    './constants',
    './projects-manager',
    '../../common/js/hash-util'
], function (
    _,
    Logger,
    constants,
    projectsManager,
    hashUtil
) {
    'use strict';

    var logger = new Logger();
    var indexView = null;
    var currentHash = null;
    var isLogin = false;
    var currentViewId = null;

    var refresh = function () {
        currentHash = parseCurrentHash();

        if (!indexView) {
            return;
        }

        var currentView = indexView.showSingleSubView(currentHash.view);
        if (currentViewId !== currentView.id) {
            currentView.setContent(null);
            currentViewId = currentView.id;
        }

        if (currentView.id === constants.ID_PROJECT_VIEW) {
            var pid = parseInt(currentHash.pid), bid = parseInt(currentHash.bid);
            var project = projectsManager.getProject(pid);
            project.getBranch(bid).then(function (branch) {
                var subViewId = currentHash.subview? currentHash.subview : constants.ID_PROJECT_OVERVIEW_VIEW;
                var subView = currentView.showSingleSubView(subViewId);
                currentView.selectMenuItemByView(subView);
                currentView.setContent({
                    project: project,
                    branch: branch
                });
                // to prevent runaway promise in Project Dashboard
                return null;
            });
        }
        else if (currentView.id === constants.ID_REPOSITORY_LIST_VIEW) {
            currentView.setContent({
                repositories: projectsManager.getRepositories()
            });
        }
        else if (currentView.id === constants.ID_PROJECT_LIST_VIEW) {
            currentView.setContent({
                projects: projectsManager.getProjects()
            });
        }
        else if (currentView.id === constants.ID_ACCOUNT_SETTINGS_VIEW) {
            currentView.setContent({
            });
        }
        else if (currentView.id === constants.ID_LOGIN_VIEW) {
            // FIXME: site로 redirect
        }
        else {
            logger.error('Unknown view', currentView);
        }
    };

    function navigate(hashs) {
        window.location.hash = hashUtil.encodeHash(hashs);
    };

    function parseCurrentHash() {
        var hashs = hashUtil.decodeHash(window.location.hash);

        // project view의 경우 login 상관없이 보여줌
        if (hashs.view && hashs.view === constants.ID_PROJECT_VIEW) {
            return hashs;
        }

        // project view를 제외하고 로그인이 안되어있을 경우 login view를 보여줌
        if (!isLogin) {
            hashs.view = constants.ID_LOGIN_VIEW;
            return hashs;
        }

        // 로그인이 되어 있는 경우

        // project가 있을 경우 view를 지정하지 않으면 project list view가 기본화면
        // 로그인 된 상태이므로 login view를 지정해도 project list view를 보여줌
        if (hashs.view === constants.ID_LOGIN_VIEW || !hashs.view) {
            hashs.view = constants.ID_PROJECT_LIST_VIEW;
        }

        // view의 이름이 잘못되었을 경우 처리
        var registeredView = _.find(indexView.subViews, function (subView) {
            return subView.id === hashs.view;
        })
        if (!registeredView) {
            hashs.view = constants.ID_PROJECT_LIST_VIEW;
        }

        return hashs;
    }

    function init(view, loginStatus) {
        indexView = view;
        isLogin = loginStatus;
    }

    function getCurrentHash() {
        return currentHash;
    }

    function setIsLogin(loginStatus) {
        isLogin = loginStatus;
    }

    window.onhashchange = refresh;

    return {
        init: init,
        refresh: refresh,
        navigate: navigate,
        getCurrentHash: getCurrentHash,
        setIsLogin: setIsLogin
    };
});
