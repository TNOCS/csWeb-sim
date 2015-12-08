rem First, convert the input data to vrt, reprojecting from RD to wgs84, and replacing the nodata value at the same time.
rem As gdalwarp does not support AAIGrid as output, we first convert it to VRT, and use gdal_translate to translate it to an ESRI ASCII GRID file.

for %%f in (*.asc) do (
	echo Processing %%f
	"c:/Program Files/QGIS Wien/bin/gdalwarp.exe" --config GDAL_DATA "c:/OSGeo4W64/share/gdal" -srcnodata -9999 -dstnodata -1 -t_srs EPSG:4296 -s_srs EPSG:28992 -of VRT -r average %%f %%f_intermediate.vrt
	"c:/Program Files/QGIS Wien/bin/gdal_translate.exe" -of AAIGrid %%f_intermediate.vrt %%f.out
	del %%f_intermediate.vrt
)