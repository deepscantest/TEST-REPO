/* S-CORE CONFIDENTIAL
 * -------------------
 * Copyright (c) 2016 S-Core Co., Ltd. All rights reserved.
 *
 * All information contained herein is the property of S-Core.
 * Please see LICENSE file in source package.
 *
 */

define([
    'text!../html/repository-list.html',
    'toastr',
    'webida-lib/util/genetic',
    'webida-lib/util/logger/logger-client',
    './constants',
    './lite-util',
    './projects-manager',
    './view-navigator',
    '../../common/widget/view'
], function (
    repositoryListTemplate,
    toastr,
    genetic,
    Logger,
    constants,
    Util,
    projectsManager,
    viewNavigator,
    View
) {
    'use strict';

    var ID_TEMPLATE_REPOSITORY_LIST_ITEM = 'template-repos-item';
    var ID_REPOSITORY_LIST_ADD_PROJECT_BUTTON_PREFIX = 'jsa-repos-add-project-button-';
    var ID_REPOSITORY_LIST_VIEW_PROJECT_BUTTON_PREFIX = 'jsa-repos-view-project-button-';
    var CLASS_HIDDEN = 'hidden';
    var CLASS_REPOSITORY_LIST = 'jsa-repos';
    var FAIL_CREATE_PROJECT = 'Project was not created.';

    var repositoryListElement;

    var logger = new Logger();

    function clickAddProjectButtonHandler(event, repository, addProjectButton, viewProjectButton) {
        if (repository.project) {
            return;
        }

        $(addProjectButton).toggleClass(CLASS_HIDDEN, true);

        // default_branch is the "base" branch in your repository. e.g. https://github.com/deepscan/TEST-REPO/settings/branches
        var projectInfo = {
            name: repository.full_name,
            type: constants.PROJECT_TYPE_GITHUB,
            url: repository[constants.GIT_CLONE_URL],
            branch: repository.default_branch
        };
        projectsManager.addProject(projectInfo).spread(function (project, branch, analysis) {
            repository.project = project;
            $(viewProjectButton).toggleClass(CLASS_HIDDEN, false);
            Util.gotoProjectDashboard(viewNavigator, project.id, branch.id);
        }).catch(function (error) {
            logger.error('Failed to add a project', error);
            toastr.error(FAIL_CREATE_PROJECT);
        });
    }

    function clickViewProjectButtonHandler(event, repository) {
        var project = repository.project;
        if (!project) {
            return;
        } else {
            Util.gotoProjectDashboard(viewNavigator, project.id, project.lastBid);
        }
    }

    function createRepositoryListItem(parent, repository) {
        var templateRepositoryListItem = $('#' + ID_TEMPLATE_REPOSITORY_LIST_ITEM).html();
        var template = _.template(templateRepositoryListItem);
        var repositoryListItem = template({
            name: repository.full_name,
            no: repository.no,
            description: repository.description
        });

        var tempDiv = document.createElement('div');
        tempDiv.innerHTML = repositoryListItem;
        parent.appendChild(tempDiv);

        var addProjectButton = parent.querySelector('#' + ID_REPOSITORY_LIST_ADD_PROJECT_BUTTON_PREFIX + repository.no);
        var viewProjectButton = parent.querySelector('#' + ID_REPOSITORY_LIST_VIEW_PROJECT_BUTTON_PREFIX + repository.no);

        var isProject = repository.project ? true : false;
        $(addProjectButton).toggleClass(CLASS_HIDDEN, isProject);
        $(viewProjectButton).toggleClass(CLASS_HIDDEN, !isProject);

        $(parent).on('click', '#' + ID_REPOSITORY_LIST_ADD_PROJECT_BUTTON_PREFIX + repository.no, function (event) {
            clickAddProjectButtonHandler(event, repository, addProjectButton, viewProjectButton);
        });

        $(parent).on('click', '#' + ID_REPOSITORY_LIST_VIEW_PROJECT_BUTTON_PREFIX + repository.no, function (event) {
            clickViewProjectButtonHandler(event, repository);
        });
    }

    function RepositoryListView() {
        View.apply(this, arguments);
    }

    genetic.inherits(RepositoryListView, View, {
        clearAll: function () {
            var $repositoryListElement = $(repositoryListElement);
            if (!$repositoryListElement.is(':empty')){
                $repositoryListElement.empty();
            }
            // Should remove event handlers because this view is used in SPA architecture.
            $repositoryListElement.off();
        },

        /**
         * @override
         */
        init: function (id, element) {
            View.prototype.init.call(this, id, element);
            this.createControl(element);

            return this;
        },

        /**
         * @override
         */
        redraw: function () {
            this.clearAll();

            if (!this.content) {
                return;
            }

            // Draws repository list.
            _.map(this.content.repositories, function (repository) {
                createRepositoryListItem(repositoryListElement, repository);
            });

        },

        createControl: function (element) {
            var self = this;

            element.innerHTML = repositoryListTemplate;
            repositoryListElement = element.querySelector('.' + CLASS_REPOSITORY_LIST);
        }
    });

    return RepositoryListView;
});
