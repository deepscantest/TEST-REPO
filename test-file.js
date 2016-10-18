
    
    //Grade
var ratingComputer = {
    _density: function (defects, loc) {
        return (defects / loc) * 1000;
    },

    _getImpactCount: function (defects) {
        return _.countBy(defects, function (defect) {
            if (defect.impact == 'high') {
                return 'high';
            } else if (defect.impact == 'medium') {
                return 'midium';
            } else if (defect.impact == 'low') {
                return 'low';
            } else {
                return 'others';
            }
        });
    },
    
    compute: function (defects, loc) {
        var highImpact;  // get high impact count
        var mediumImpact; // get medium impact count
        var lowImpact; // get low impact count

        var impactCount = this._getImpactCount(defects);
        var highDensity = this._density(impactCount.high, loc);
        var mediumDensity = this._density(impactCount.medium, loc);
        var lowDensity = this._density(impactCount.low, loc);
        var rating;

        if (highDensity >= level.poor.high_medium_impact_threshold || mediumDensity >= level.poor.high_medium_impact_threshold || lowDensity >= level.poor.low_impact_threshold) {
            rating = level.poor.name;
        }else {
            if (lowDensity < level.good.low_impact_threshold) {
                rating = level.good.name;
            } else if (lowDensity < level.normal.low_impact_threshold) {
                rating = level.normal.name;
            }
        }

        logger.debug('Computed rating', rating);
        return rating;
    }
};
