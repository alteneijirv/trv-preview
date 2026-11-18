TRV local UAE overview imagery — sources and notices

SATELLITE
Contains modified Copernicus Sentinel data 2026

Real Sentinel-2 Level2A red/green/blue reflectance data from the public,
unsigned Element84 EarthSearch collection hosted on AWS. Original 10 m
samples were averaged to 107.2265625 m and rendered with one fixed RGB curve.
Cloud/shadow/nodata SCL classes 0,1,3,8,9,10,11 were excluded. Captures may
have different dates and atmospheric conditions; this is not live imagery.
The exact captures, sampled classifications, catalog-declared source asset
checksums, locally verified output checksums, dates and coverage are preserved
in the build evidence. Remote source COGs were range-read; their whole-file
checksums were not independently downloaded and rehashed.

Source https://registry.opendata.aws/sentinel-2-l2a-cogs/
Legal notice https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice
An unmodified copy of that notice is supplied as sentinel-data-legal-notice.pdf.
The notice grants reproduction, distribution and adaptation subject to its
source notice and other terms. No ESA/EU endorsement of TRV is implied.

TERRAIN
Mapzen Terrain Tiles. SRTM and GMTED2010 data courtesy of the U.S. Geological
Survey. ETOPO1: DOC/NOAA/NESDIS/NCEI — National Centers for Environmental
Information, NESDIS, NOAA, U.S. Department of Commerce.
U.S. Government material incorporated here is not subject to copyright
protection within the United States.

Source https://registry.opendata.aws/terrain-tiles/
Source formats https://github.com/tilezen/joerd/blob/master/docs/formats.md
Sources https://github.com/tilezen/joerd/blob/master/docs/data-sources.md
Attribution https://github.com/tilezen/joerd/blob/master/docs/attribution.md
An unmodified copy of the provider attribution document is supplied here.

Finite 512 px GeoTIFF elevation tiles from the unsigned public AWS dataset
were processed locally. Their source headers are checked and only SRTM,
GMTED and ETOPO1 sources are accepted for this pack. UAE terrain at source
zoom 9 is sampled at about 137–142 m on the ground; source land data are mainly
SRTM nominal 30 m samples, with coarser fallback and ocean bathymetry.
SRTM was acquired in 2000; this is historical terrain. TRV modified these
data by resampling, elevation coloring and shaded relief with 3× visual
exaggeration. Elevations at/below 0 m are blue; that is not a verified coastline.
No USGS/NOAA/Mapzen endorsement of TRV is implied. ETOPO1 is not suitable
for navigation and must not be used for nautical navigation.

PACK LIMITS
Both layers are finite static overviews, locally bundled in XYZ JPEG tiles.
Zooming beyond native zoom 11 magnifies the same data; it adds no detail.
These are not detailed street photographs, a current dune survey, or proof
that an off-road route is legal, accessible or safe. Missing satellite data
are slate-colored; no imagery is invented to fill gaps.
The rectangular display bounds are not a national border. Administrative
mask coverage is measured separately at the output sampling scale; it does
not establish a precise coastline or visibility of every small island.

صور الأقمار الصناعية والتضاريس نظرات عامة محلية ثابتة وليست بثاً حياً.
التكبير لا يضيف تفاصيل جديدة. التغطية الإدارية ليست تحققاً مستقلاً من خط
الساحل أو كل جزيرة صغيرة. لا تثبت هذه الصور سلامة أو قانونية عبور الصحراء.

No Google, OpenStreetMap or OpenTopoMap tile cache was used to make these
imagery layers. The Copernicus WorldDEM product was researched but is not
used in this pack. Other TRV map/search/routing data have their own notices.
