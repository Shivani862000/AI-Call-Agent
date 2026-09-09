-- 0025_campaign_identity.sql
-- Preserve campaign attribution by id when a display name changes.

alter table customers add column campaign_id bigint;

update customers c
   set campaign_id = cfg.id
  from campaign_configs cfg
 where c.campaign_id is null
   and c.campaign_name is not null
   and lower(c.campaign_name) = lower(cfg.name);

alter table customers
  add constraint customers_campaign_id_fkey
  foreign key (campaign_id) references campaign_configs(id) on delete set null;
create index customers_campaign_id_idx on customers(campaign_id);

create or replace function customers_set_campaign_id() returns trigger as $$
begin
  if new.campaign_id is null and nullif(trim(new.campaign_name), '') is not null then
    select id into new.campaign_id
      from campaign_configs
     where lower(name) = lower(trim(new.campaign_name))
     order by id
     limit 1;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists customers_set_campaign_id_trg on customers;
create trigger customers_set_campaign_id_trg
  before insert or update of campaign_id, campaign_name on customers
  for each row execute function customers_set_campaign_id();
