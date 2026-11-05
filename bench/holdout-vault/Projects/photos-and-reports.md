# Photos and problem reports

Members report problems (broken fence, rats near the compost, a leaking water butt) with an optional photo.

## Privacy

Phone photos carry GPS coordinates in their EXIF data. The upload handler removes all EXIF data and resizes the photo to 1280 pixels on the long side before it is stored.

```python
def clean_photo(image):
    image = strip_exif(image)
    image.thumbnail((1280, 1280))
    return image
```

## Triage

Reports go to a shared inbox for the committee. A report is marked "fixed" by a committee member, never by the person who reported it.
