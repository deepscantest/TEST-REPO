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
    // Securing your webhooks and secure_compare reference : https://developer.github.com/webhooks/securing/
    if (headers['x-hub-signature']) {
        var crypto = require('crypto');
        var compare = require('secure-compare');

        // 환경변수의 secret(github에 설정된 값과 동일)과 body를 가지고 signature를 생성
        var secret = process.env.WEBHOOK_SECRET;
        var hmac = crypto.createHmac('sha1', secret);
        hmac.update(JSON.stringify(body));
        var signature = 'sha1=' + hmac.digest('hex');

        // 생성된 signature값과 github에서 보내온 값을 비교
        if (!compare(headers['x-hub-signature'], signature)) {
            logger.error('Signatures didn\'t match!');
            req.resultPromise = Promise.reject(new JsaError('Signatures didn\'t match!'));
            return next();
        }
    }

    // Check that GitHub sent the payload (because malicious user can send payload)
    // more github delivery header info: https://developer.github.com/webhooks/
    if (!headers['x-github-event'] || (headers['x-github-event'] != 'push')) {
        var errMsg;
        if (!headers['x-github-event']) {
            errMsg = 'Invalid access: Request from non-GitHub';
        } else {
            errMsg = 'Unsupported event type';
        }
        logger.error(errMsg);
        req.resultPromise = Promise.reject(new JsaError(errMsg));
    } else if (!url || !branch){
        logger.error('Missing args: Git url or branch name');
        req.resultPromise = Promise.reject(new JsaError('Missing args: Git url or branch name'));
    } else {
        req.resultPromise = jsaManager.autoAnalysis(url, branch, commitId);
    }

    return next();
});
