
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
