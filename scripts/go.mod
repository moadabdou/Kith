module github.com/moadabdou/Kith/scripts

go 1.27

replace github.com/moadabdou/Kith/api => ../api

require (
	github.com/gocql/gocql v1.7.0
	github.com/jackc/pgx/v5 v5.11.0
	github.com/moadabdou/Kith/api v0.0.0-00010101000000-000000000000
	golang.org/x/crypto v0.57.0
)

require (
	github.com/golang/snappy v0.0.3 // indirect
	github.com/hailocab/go-hostpool v0.0.0-20160125115350-e80d13ce29ed // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/rogpeppe/go-internal v1.16.0 // indirect
	golang.org/x/sync v0.23.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
	gopkg.in/inf.v0 v0.9.1 // indirect
)
