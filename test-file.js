//Grade
var RatingComputer = {
    Level :{
        POOR : { name: 'POOR', high_medium_impact_threshold: '1', low_impact_threshold: '10'},
        NORMAL : { name: 'NORMAL', high_medium_impact_threshold: '1', low_impact_threshold: '10'},
        GOOD : { name: 'GOOD', high_medium_impact_threshold: '1', low_impact_threshold: '5'}
    },

    _density: function (defects, loc) {
        return (defects / loc) * 1000;
    },

    compute: function (loc, alarms) {
        var highImpact;  // get high impact count
        var mediumImpact; // get medium impact count
        var lowImpact; // get low impact count

        var highDensity = this._density(highImpact, loc);
        var mediumDensity = this._density(mediumImpact, loc);
        var lowDensity = this._density(lowImpact, loc);

        var rating;

        if (highDensity >= Level.POOR.high_medium_impact_threshold || mediumDensity >= Level.POOR.high_medium_impact_threshold || lowDensity >= Level.POOR.low_impact_threshold) {
            rating = Level.POOR.name;
        }else {
            if (lowDensity < Level.GOOD.low_impact_threshold) {
                rating = Level.GOOD.name;
            } else if (lowDensity < Level.NORMAL.low_impact_threshold) {
                rating = Level.NORMAL.name;
            }
        }

        logger.debug('Computed rating', rating);
        return rating;
    }
}
