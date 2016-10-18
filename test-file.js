
//Grade
var level = {
    poor : { name: 'POOR', high_medium_impact_threshold: '1', low_impact_threshold: '10'},
    normal : { name: 'NORMAL', high_medium_impact_threshold: '1', low_impact_threshold: '10'},
    good : { name: 'GOOD', high_medium_impact_threshold: '1', low_impact_threshold: '5'}
};
    
var ratingComputer = {
    _density: function (defects, loc) {
            return (defects / loc) * 1000;
    },

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
        if (!loc) {
            return '';
        }

        var rating;
        if (!defects) {
            rating = level.good.name;
        } else {
            var impactCount = this._getImpactCount(defects);

            var highDensity = this._density(impactCount.high, loc);
            var mediumDensity = this._density(impactCount.medium, loc);
            var lowDensity = this._density(impactCount.low, loc);

            if (highDensity >= level.poor.high_medium_impact_threshold || mediumDensity >= level.poor.high_medium_impact_threshold || lowDensity >= level.poor.low_impact_threshold) {
                rating = level.poor.name;
            }else {
                if (lowDensity < level.good.low_impact_threshold) {
                    rating = level.good.name;
                } else if (lowDensity < level.normal.low_impact_threshold) {
                    rating = level.normal.name;
                }
            }
        }

        logger.debug('Computed rating', rating);
        return rating;
    }
};
