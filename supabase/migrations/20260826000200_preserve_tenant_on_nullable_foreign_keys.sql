begin;

alter table public.campaign_configurations
  drop constraint campaign_configurations_client_agent_fk,
  add constraint campaign_configurations_client_agent_fk
    foreign key (client_id, agent_id)
    references public.agents (client_id, id)
    on delete set null (agent_id);

alter table public.support_tickets
  drop constraint support_tickets_client_customer_fk,
  add constraint support_tickets_client_customer_fk
    foreign key (client_id, customer_id)
    references public.customers (client_id, id)
    on delete set null (customer_id),
  drop constraint support_tickets_client_call_fk,
  add constraint support_tickets_client_call_fk
    foreign key (client_id, call_id)
    references public.calls (client_id, id)
    on delete set null (call_id);

commit;
