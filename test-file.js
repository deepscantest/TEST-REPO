function getBranchOutstandingDefects(branchId) {
 52     _density: function (defects, loc) {                                                                         |299     return getBranchDefects(branchId).then(function (defects) {
 53         return (defects / loc) * 1000;                                                                          |300         return _.filter(defects, function (defect) {
 54     },                                                                                                          |301             return defect.status === constants.LITE_DEFECT_STATUS_NEW || defect.status === constants.LITE_DEFECT
 55                                                                                                                 |    _STATUS_TRIAGED;
 56     _getImpactCount: function (defects) {                                                                       |302         });
 57         return _.countBy(defects, function (defect) {                                                           |303     });
 58             if (defect.impact == 'high') {                                                                      |304 }
 59                 return 'high';                                                                                  |305 
 60             } else if (defect.impact == 'medium') {                                                             |306 /**
 61                 return 'midium';                                                                                |307  * 머지 대상이 될 Defect 리스트 리턴.
 62             } else if (defect.impact == 'low') {                                                                |308  * @param {string} branchId - 브랜치 Id
 63                 return 'low';                                                                                   |309  * @return {array} defects 결함 객체
 64             } else {                                                                                            |310  */
 65                 return 'others';                                                                                |311 function getMergeableTargetDefects(branchId) {
 66             }                                                                                                   |312     var aidCache = {};
 67         });                                                                                                     |313     return dbLiteDefect.getDefectsAsync({
 68     },                                                                                                          |314         ownerBranchIds: [branchId],
 69                                                                                                                 |315         statuses: ['New', 'Triaged', 'Dismissed']
 70     compute: function (defects, loc) {                                                                          |316     }).then(function (context) {
 71         var highImpact;  // get high impact count                                                               |317         var defects = context.result();
 72         var mediumImpact; // get medium impact count                                                            |318         return Promise.map(defects, function (defect) {
