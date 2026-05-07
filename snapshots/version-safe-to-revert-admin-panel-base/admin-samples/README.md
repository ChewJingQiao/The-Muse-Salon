# Availability Format Samples

The live lightweight booking system now uses the CSV approach.

Admin page:

- URL: `http://localhost:4173/admin.html`
- Default password source: `admin-config.local.json`
- Change the placeholder password before real use.

Current live data files:

- Availability rows: `data/availability.csv`
- Business hours and slot length: `data/booking-settings.json`

How staff can use it:

1. Open `admin.html`
2. Sign in with the admin password
3. Upload a CSV exported from Excel, or paste/edit the CSV text directly
4. Save the availability
5. The booking form on `contact.html` will only show valid time slots for the chosen date

Upload rules:

- The uploaded filename does not matter
- The system reads the CSV content, not the filename
- The CSV must include the required column names
- The date format must be `YYYY-MM-DD`
- Time format must be `HH:MM` in 24-hour format
- `blocked` rows must include both `start_time` and `end_time`
- `closed` rows block the whole day, so `start_time` and `end_time` can be left empty

`availability.sample.csv`

- Can be opened in Excel, Numbers, or Google Sheets
- Much easier for non-technical users to edit than JSON
- This is the recommended admin format for The Muse Salon

CSV columns:

- `date`
- `status`
- `start_time`
- `end_time`
- `reason`

Column name notes:

- These column names must exist in the CSV
- They can be in a different order and the system will still read them
- Extra columns are not supported in the current lightweight version

Status rules:

- `closed` blocks the full day
- `blocked` blocks only the time range between `start_time` and `end_time`

Example:

```csv
date,status,start_time,end_time,reason
2026-05-20,closed,,,Salon closed for training
2026-05-12,blocked,13:00,14:30,Lunch / private appointment
2026-05-17,blocked,16:00,17:00,Staff unavailable
```
