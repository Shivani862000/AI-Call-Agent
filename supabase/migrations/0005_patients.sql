-- 0005_patients.sql — patient records become a first-class entity.
create table patients (
  id                  bigint generated always as identity primary key,
  reference_id        text,
  first_name          text not null,
  last_name           text,
  phone               text not null,
  normalized_phone    text,
  email               text,
  preferred_call_slot text default '10:00',
  preferred_language  text not null default 'hi' check (preferred_language in ('en','hi')),
  date_of_birth       date,
  gender              text default 'unknown' check (gender in ('male','female','other','unknown')),
  blood_group         text default 'unknown'
                        check (blood_group in ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
  last_donation_date  date,
  last_test_date      date,
  do_not_call         integer not null default 0,
  consent_status      text not null default 'unknown'
                        check (consent_status in ('unknown','granted','refused')),
  consent_updated_at  timestamptz,
  status              text not null default 'active' check (status in ('active','inactive')),
  notes               text,
  created_by          text,
  updated_by          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Same guard as customers: one person cannot be entered twice in different
-- phone formats. Partial, because normalized_phone is nullable.
create unique index patients_normalized_phone_key on patients (normalized_phone)
  where normalized_phone is not null;
create unique index patients_reference_id_key on patients (lower(reference_id))
  where reference_id is not null;
create index patients_status_idx on patients (status);
create index patients_name_idx on patients (lower(first_name), lower(last_name));

-- Written in phase 1, read in phase 2.
alter table customers add column patient_id bigint;
alter table customers add constraint customers_patient_fk
  foreign key (patient_id) references patients(id) on delete set null;
create index customers_patient_id_idx on customers (patient_id);
